// NPC records, stamps and context slices. The server stores nothing during play: a cast file is the
// template, and every change is a stamp on the message (extra.worldscrawl_npc), per swipe.
// Schedules resolve through the same kind of redirect a player position uses. A bad entry is marked, never thrown.

import { npc } from './shared.mjs';
import { APPEARANCE_FIELDS, alreadyEffect, alreadyShown, appearanceFieldsChanged, appearanceIntent, effectFields, effectSetKey, judgeAppearance, junkAppearanceIntent, noopAppearance, resolveAppearance, rebuildInputs, readAppearanceAnswer, sameAppearanceBase, planAppearanceRebuild, acceptAppearanceRebuild, classifyAppearanceReply, planLooksSummary, acceptLooksSummary, looksInputKey } from './npceffects.mjs';
import { composeRecords, isOwnerStamp, pinBaseline, projectAppearance, readBaselineMap } from './replay.mjs';
export { APPEARANCE_FIELDS, alreadyEffect, alreadyShown, appearanceFieldsChanged, appearanceIntent, effectFields, effectSetKey, judgeAppearance, junkAppearanceIntent, noopAppearance, resolveAppearance, rebuildInputs, readAppearanceAnswer, sameAppearanceBase, planAppearanceRebuild, acceptAppearanceRebuild, classifyAppearanceReply, planLooksSummary, acceptLooksSummary, looksInputKey };

const { APPEARANCE_MAX, DISPOSITIONS, HISTORY_MAX, MEMORY_CAP, NPC_ID, NPC_TOKEN, exportRecord, authorRecord, isObj, label, matchEnum, nameIn, normName, npcTokenIds, resolveNear, resolveSchedulePlace, str } = npc;

export const NPC_KEY = 'worldscrawl_npc';

export const FOUND_KEY = 'worldscrawl_found';

export const PLAYER = 'player';

export const SUGGEST_AFTER = 3;

export const READBACK_CAP = 24;

export const STAY_SECONDS = 3600;

const LADDER = DISPOSITIONS;

/** Card text fields a stamp can set: stamp field -> folded key. Legacy names (manner, voice, appearance) still apply. */
export const CARD_FIELDS = { line: 'line', 'personality.summary': 'line', 'personality.manner': 'manner', 'personality.speech': 'voice', manner: 'manner', voice: 'voice',
    'appearance.summary': 'looks', 'appearance.body': 'body', 'appearance.outfit': 'outfit', appearance: 'body', unknownAs: 'unknownAs' };

export const NPC_WARN_KEY = 'worldscrawl_npcwarn';
/**
 * Whether a narrator stamp is visible on the folded person.
 * 'waiting' is a lasting change still on its Approve notice. 'missed' is a claim that is not on the card.
 * Appearance counts as landed once the effect is on the person (a pending rebuild is still that effect).
 */
export function claimResult(npc, stamp) {
    if (!stamp || typeof stamp !== 'object') return 'missed';
    if (stamp.pending === true) return 'waiting';
    if (!npc) return 'missed';
    if (stamp.type === 'npc_fact') {
        const field = String(stamp.field ?? 'fact');
        const text = String(stamp.text ?? '').trim();
        if (!text) return 'missed';
        if (CARD_FIELDS[field]) return String(npc[CARD_FIELDS[field]] ?? '').trim() === text ? 'landed' : 'missed';
        if (field === 'history' || field === 'deep.history') return String(npc.deep?.history ?? '').trim() === text ? 'landed' : 'missed';
        if (field === 'deep.secrets') return (npc.deep?.secrets ?? []).some(x => String(x).trim() === text) ? 'landed' : 'missed';
        if (field.startsWith('deep.relationships.')) {
            const who = field.slice('deep.relationships.'.length);
            return String(npc.deep?.relationships?.[who] ?? '').trim() === text ? 'landed' : 'missed';
        }
        const facts = [...(npc.facts ?? []), ...(npc.temps ?? []).map(t => t?.text ?? t)];
        return facts.some(f => String(f).trim() === text) ? 'landed' : 'missed';
    }
    if (stamp.type === 'npc_memory') {
        const note = String(stamp.note ?? '').trim();
        return note && (npc.memory ?? []).some(m => String(m).trim() === note) ? 'landed' : 'missed';
    }
    if (stamp.type === 'npc_disposition') {
        const who = stamp.who || 'player';
        return npc.disposition?.[who]?.value === stamp.value ? 'landed' : 'missed';
    }
    if (stamp.type === 'npc_appearance' || stamp.type === 'npc_baseline') {
        if (stamp.candidate && !stamp.committed) return 'waiting';
        if (!stamp.committed) return 'missed';
        const lasting = !(stamp.lasts > 0);
        const inLasting = (npc.lastingOps ?? []).some(o => o.owner === stamp.owner);
        const inLive = (npc.liveOps ?? []).some(o => o.owner === stamp.owner);
        if (lasting) return inLasting ? 'landed' : 'missed';
        return inLive ? 'landed' : 'missed';
    }
    return 'landed';
}
/** The warning line when a claimed person update is not on the card. */
export function claimMissText(stamp, who = '') {
    const name = who || stamp?.id || 'someone';
    return `Warning: a person update for ${name} did not land on the card.`;
}
/** Warning lines for stamps that were applied and are not waiting, but are not on `npc`. */
export function claimWarnings(npc, stamps) {
    const who = npc?.name || '';
    const out = [];
    for (const s of stamps ?? []) {
        if (claimResult(npc, s) !== 'missed') continue;
        out.push(claimMissText(s, who || s?.id || ''));
    }
    return out;
}

const DAY_MINUTES = 1440;

const cleanList = (v, cap) => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim().slice(0, 200) : '')).filter(Boolean).slice(0, cap) : []);

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

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

/** True when `minutes` sits in [from, to). A window that passes midnight wraps. No times means always. */
export function inTimeWindow(minutes, from, to, dayMinutes = DAY_MINUTES) {
    if (from == null && to == null) return true;
    const start = from ?? 0, end = to ?? dayMinutes;
    if (start === end) return true;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
}

/** True when room address `here` is the mapped place `near` (a room, anywhere in that subregion, or anywhere in that region). */
export function withinNear(here, near) {
    if (!here || !near || near.kind !== 'map') return false;
    if (near.scope === 'room') return here === near.address;
    if (near.scope === 'subregion') return here === near.address || here.startsWith(`${near.address}/`);
    if (near.scope === 'region') return here.split(':')[0] === near.address;
    return false;
}

const nearOf = (entry, env) => resolveNear(entry?.near, env?.index ? { ...env.index, exists: env.exists ?? env.index.exists, relocate: env.relocate ?? env.index.relocate ?? {} } : null);

/** The schedule entry in force at `clock.minutes`. A placeless entry is off the map (address null) unless a found stamp for its `where` label names a room. */
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
        if (!entry.place) {
            const where = entry.where ?? '';
            const near = nearOf(entry, env);
            const hit = npc.found?.[where];
            if (hit?.place) {
                const r = resolveSchedulePlace(hit.place, env);
                if (r.ok) return { address: r.address, how: 'found', activity: entry.activity, entry, kind: 'schedule', where, near, offmap: false };
            }
            return { address: null, offmap: true, how: 'offmap', activity: entry.activity, entry, kind: 'schedule', where, near };
        }
        const r = resolveSchedulePlace(entry.place, env);
        if (r.ok) return { address: r.address, how: r.how, activity: entry.activity, entry, kind: 'schedule' };
    }
    return null;
}

/** Narrator line for someone whose current entry keeps them off the map. */
export function offmapAbsentLine(npc, sched) {
    const name = npc?.name || 'Someone';
    const activity = sched?.activity || sched?.entry?.activity || 'away';
    const where = sched?.where || sched?.entry?.where || '';
    const near = sched?.near;
    let place = '';
    if (near?.kind === 'map') place = `in ${near.name || near.address}`;
    else if (near?.kind === 'stub') place = `in ${near.name}${near.about ? `, ${near.about}` : ''}`;
    else if (near?.kind === 'text' && near.text) place = near.text;
    const hint = [where, place].filter(Boolean).join(', ');
    return `${name}: ${activity}, somewhere off the map${hint ? ` (${hint})` : ''}`;
}

/** How a resolved near reads in the inspector: "map: The Drowned Rat (riverton:drowned_rat)". */
export function nearPhrase(near) {
    if (!near || near.kind === 'none') return 'nowhere named';
    if (near.kind === 'map') return `map: ${near.name || near.address} (${near.address}, ${near.scope})`;
    if (near.kind === 'stub') return `stub: ${near.name}${near.about ? ` — ${near.about}` : ''}`;
    const note = near.warn === 'typo' ? 'probably a typo' : 'not in the list';
    return `text: ${near.text} (${note})`;
}

/**
 * Inspector view of who is off the map, the stub-region list (and who is off in each), and found-flag outcomes.
 * `play` is npcPlayState's rows (each may carry why.schedule and foundAttempts).
 */
export function offMapReport(play, elsewhere = []) {
    const people = [];
    for (const n of play ?? []) {
        const s = n.why?.schedule;
        if (!s?.offmap) continue;
        people.push({ id: n.id, name: n.name, activity: s.activity ?? '', where: s.where ?? '', near: s.near ?? { kind: 'none' }, how: nearPhrase(s.near) });
    }
    const stubs = (elsewhere ?? []).map(s => ({
        id: s.id, name: s.name, about: s.about ?? '', lore: !!s.lore, shadowed: !!s.shadowed,
        who: people.filter(p => p.near?.kind === 'stub' && p.near.id === s.id).map(p => ({ id: p.id, name: p.name, activity: p.activity, where: p.where })),
    }));
    const found = [];
    for (const n of play ?? []) for (const a of n.foundAttempts ?? []) found.push({ id: n.id, name: n.name, ...a });
    return { people, stubs, found };
}

/**
 * Whether a found flag may put `npc` in `room` for the placeless entry in force.
 * Accepted only when `near` is a map address and `room` is within it. A stub or plain-text near cannot be found.
 */
export function judgeFound(npc, clock, room, env) {
    const name = npc?.name || 'They';
    const sched = scheduleAt(npc, clock, env);
    if (!sched) return { ok: false, reason: `${name} has no schedule in force.` };
    const placeless = sched.offmap || sched.how === 'found';
    if (!placeless) {
        const where = placeLabel(env, sched.address);
        return { ok: false, reason: `${name} is already on the map (${where}${sched.activity ? `, ${sched.activity}` : ''}).` };
    }
    const near = sched.near;
    const where = sched.where ?? '';
    if (!near || near.kind === 'none') return { ok: false, where, reason: `${name} is off the map with no "near", so they can't be found in a room.` };
    if (near.kind === 'stub') return { ok: false, where, reason: `${name} is off in ${near.name}${near.about ? `, ${near.about}` : ''}, which is not on the map, so they can't be found in a room.` };
    if (near.kind === 'text') return { ok: false, where, reason: `${name} is off the map (${near.text}), not near a mapped place, so they can't be found in a room.` };
    if (!room) return { ok: false, where, reason: 'There is no current room to find them in.' };
    if (!withinNear(room, near)) return { ok: false, where, reason: `${name} is near ${near.name || near.address}, and this room is not within it.` };
    return { ok: true, where, place: room, reason: `Accepted: this room is within ${near.name || near.address} (${near.scope}).` };
}

/** An edited found room still has to be on the map and within the `where` label's near. */
export function foundEditOk(npc, where, place, env) {
    const label = String(where ?? '').trim();
    const entry = (npc?.schedule ?? []).find(e => e && !e.broken && !e.place && (e.where ?? '') === label);
    if (!entry) return { ok: false, reason: 'No off-map entry uses that where.' };
    const near = nearOf(entry, env);
    if (near.kind !== 'map') return { ok: false, reason: 'That where is not near a mapped place.' };
    const r = resolveSchedulePlace(place, env);
    if (!r.ok) return { ok: false, reason: 'That room is not on the map.' };
    if (!withinNear(r.address, near)) return { ok: false, reason: `That room is not within ${near.name || near.address}.` };
    return { ok: true, place: r.address };
}

/** The npc_name stamp a [name] / [ws_flag: name] records, or why the name matched nobody. */
export function nameStampFor(npcs, name, { who = PLAYER, source = 'bracket' } = {}) {
    const n = npcForName(npcs, name);
    if (!n) return { ok: false, reason: `No saved person is called "${String(name ?? '').trim()}".` };
    return { ok: true, id: n.id, name: n.name, stamp: { type: 'npc_name', id: n.id, who, source: source === 'bracket' ? 'bracket' : 'flag' } };
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
    const looks = rec.looks ?? '', body = rec.body ?? '', outfit = rec.outfit ?? '';
    const base = rec.base ? { looks: rec.base.looks ?? looks, body: rec.base.body ?? body, outfit: rec.base.outfit ?? outfit, ...(rec.base.looksPair ? { looksPair: rec.base.looksPair } : {}) } : { looks, body, outfit };
    if (!base.looksPair) base.looksPair = looksInputKey(base.body ?? '', base.outfit ?? '');
    return {
        id: rec.id, name: rec.name, line: rec.line, manner: rec.manner ?? '', voice: rec.voice ?? '',
        looks, body, outfit, castLooks: looks, base, effects: [], caches: {}, appearanceHow: 'base', appearanceKey: '',
        unknownAs: rec.unknownAs ?? '', rel: clone(rec.rel ?? {}),
        invented: [...(rec.invented ?? [])], deep: clone(rec.deep ?? {}), facts: [...(rec.facts ?? [])], memory: [...(rec.memory ?? [])].slice(-MEMORY_CAP),
        disposition: clone(rec.disposition ?? {}), fromCast: new Set(Object.keys(rec.disposition ?? {})),
        schedule: (rec.schedule ?? []).map(e => ({ ...e })), seen_at: rec.seen_at ? { ...rec.seen_at } : null,
        ok: rec.ok !== false, from: rec.from ?? 'cast', following: null, held: null, appearances: [], seeks: [], stays: [], found: {}, temps: [],
    };
}

function snapshot(state) {
    const out = new Map();
    for (const [id, n] of state) out.set(id, {
        ...n, deep: clone(n.deep), facts: n.facts.slice(), memory: n.memory.slice(), disposition: clone(n.disposition),
        fromCast: new Set(n.fromCast), rel: clone(n.rel ?? {}), invented: (n.invented ?? []).slice(), appearances: n.appearances.slice(), seeks: n.seeks.slice(), stays: n.stays.slice(), temps: (n.temps ?? []).map(t => ({ ...t })),
        base: { ...(n.base ?? { looks: n.looks, body: n.body, outfit: n.outfit }) },
        effects: (n.effects ?? []).map(e => ({ ...e, fields: (e.fields ?? []).slice(), text: e.text ? { ...e.text } : undefined })),
        caches: clone(n.caches ?? {}),
        following: n.following ? { ...n.following } : null, held: n.held ? { ...n.held } : null, schedule: n.schedule, seen_at: n.seen_at,
        found: Object.fromEntries(Object.entries(n.found ?? {}).map(([k, v]) => [k, { ...v }])),
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

const LASTS_RE = /^(?:for\s+)?(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;
/** A `lasts` value in game minutes: a number, or text like '2 hours', '30 min', '1 day'. null when lasting (or unreadable). */
export function lastsMinutes(v) {
    if (Number.isFinite(v)) return v > 0 ? Math.round(v) : null;
    const m = LASTS_RE.exec(String(v ?? '').trim());
    if (!m) return null;
    const k = m[2][0].toLowerCase();
    const n = Math.round(Number(m[1]) * (k === 'd' ? 1440 : k === 'h' ? 60 : 1));
    return n > 0 ? n : null;
}
/** A temporary change is over once `lasts` game minutes have passed since the message that made it. */
const tempOver = (t, elapsed) => Number.isFinite(t.start) && Number.isFinite(elapsed) && elapsed >= t.start + t.lasts * 60;
/** '2h', '30m', '1d4h': a lasts value for labels. */
export function lastsText(min) {
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    return `${d ? `${d}d` : ''}${h ? `${h}h` : ''}${m ? `${m}m` : ''}` || '0m';
}

/** How well an actor knows this person, in order. Automatic changes only move forward; a player edit (npc_rel) can go back. */
export const REL_STATES = ['unmet', 'met', 'named'];
/** Move `who`'s relationship with `n` forward to `state` (never back). The first meeting moves an unknown attitude to indifferent. */
function relUp(n, who, state, at, by) {
    n.rel = n.rel ?? {};
    const cur = n.rel[who]?.state ?? 'unmet';
    if (REL_STATES.indexOf(state) <= REL_STATES.indexOf(cur)) return;
    n.rel[who] = { state, at, by };
    if (cur === 'unmet' && (n.disposition[who]?.value ?? 'unknown') === 'unknown') n.disposition[who] = { value: 'indifferent', reason: 'just met' };
}
export const REL_TEXT = { unmet: "hasn't met them", met: "met, doesn't know the name", named: 'knows the name' };
const REL_WORDS = { unmet: 'unmet', "hasn't met": 'unmet', 'not met': 'unmet', never: 'unmet', met: 'met', named: 'named', name: 'named', 'knows the name': 'named', known: 'named' };
/** '/ws-know Hesk | met' → {name, state}; null state when the word is not one of them. */
export function parseRelArg(text) {
    const [name, word = ''] = String(text ?? '').split('|').map(x => x.trim());
    return { name: name ?? '', state: REL_WORDS[word.toLowerCase()] ?? null };
}
/** The relationship record for `who`: {state, at, by}; unmet (at null) when nothing set it. */
export const relOf = (n, who = PLAYER) => n?.rel?.[who] ?? { state: 'unmet', at: null, by: '' };

function applyStamp(state, s, index, elapsed = null) {
    if (!s || s.off === true || s.pending === true || typeof s.type !== 'string') return;
    const id = s.id;
    if (s.type === 'npc_create') {
        if (!id || !NPC_ID.test(id) || state.has(id)) return;
        const name = str(s.name, 80), line = str(s.line, 400);
        if (!name || !line) return;
        const t = (k, max = 400) => str(s[k], max) ?? '';
        const history = t('history', HISTORY_MAX);
        // Whoever remembered them knows their name (the player, unless the stamp says otherwise).
        state.set(id, blankFrom({ id, name, line, manner: t('manner'), voice: t('voice'), looks: t('looks', 240), body: t('body', APPEARANCE_MAX) || t('appearance', APPEARANCE_MAX),
            outfit: t('outfit', APPEARANCE_MAX), unknownAs: t('unknownAs', 80), rel: { [str(s.knownBy, 40) || PLAYER]: { state: 'named', at: index, by: 'remembered' } }, deep: history ? { history } : {}, invented: cleanList(s.invented, 12), facts: Array.isArray(s.facts) ? s.facts : [], ok: true, from: 'play', schedule: [], disposition: {} }));
        return;
    }
    if (s.type === 'npc_decline') return;
    const n = id ? state.get(id) : null;
    if (!n) return;
    if (s.type === 'npc_fact') {
        const field = String(s.field ?? 'fact');
        const text = str(s.text, field === 'history' || field === 'deep.history' ? HISTORY_MAX : /appearance/.test(field) ? APPEARANCE_MAX : 400);
        if (!text) return;
        const lasts = lastsMinutes(s.lasts);
        if (lasts) { n.temps.push({ text, at: index, lasts, start: elapsed }); return; }
        if (CARD_FIELDS[field]) {
            const key = CARD_FIELDS[field];
            n[key] = text;
            // Appearance card fields update the base so resolveAppearance does not wipe them.
            if (APPEARANCE_FIELDS.includes(key)) return;
        }
        else if (field === 'history') n.deep.history = text;
        else if (field.startsWith('deep.')) setDeep(n.deep, field, text);
        else if (!n.facts.includes(text)) n.facts.push(text); // a cast fact restamped in chat stays single
        return;
    }
    if (s.type === 'npc_memory') {
        const note = str(s.note, 240);
        if (!note) return;
        relUp(n, PLAYER, 'met', index, 'memory');
        n.memory.push(note);
        if (n.memory.length > MEMORY_CAP) n.memory.splice(0, n.memory.length - MEMORY_CAP);
        return;
    }
    if (s.type === 'npc_disposition') {
        const who = typeof s.who === 'string' && s.who ? s.who : PLAYER;
        relUp(n, who, 'met', index, 'disposition');
        const cur = n.disposition[who]?.value ?? 'unknown';
        const value = clampDisposition(cur, s.value, !!s.dramatic);
        if (!value) return;
        n.disposition[who] = { value, reason: str(s.reason, 240) ?? '' };
        return;
    }
    if (s.type === 'npc_name') { relUp(n, str(s.who, 40) || PLAYER, 'named', index, s.source === 'bracket' ? 'name bracket' : 'name flag'); return; }
    if (s.type === 'npc_rel') { // the player's edit: the only way back
        const who = str(s.who, 40) || PLAYER;
        if (REL_STATES.includes(s.state)) n.rel[who] = { state: s.state, at: index, by: 'player edit' };
        return;
    }
    if (s.type === 'npc_found') {
        const place = str(s.place, 200);
        if (!place) return;
        const where = typeof s.where === 'string' ? s.where.trim() : '';
        n.found = n.found ?? {};
        n.found[where] = { place, at: index };
        return;
    }
    if (s.type === 'npc_follow') { relUp(n, str(s.who, 40) || PLAYER, 'met', index, 'follow'); n.following = { who: str(s.who, 40) || PLAYER, at: index }; n.held = null; return; }
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
    if (s.type === 'npc_seek') { if (Number.isInteger(s.day)) n.seeks.push({ day: s.day, at: index }); return; }
    if (s.type === 'npc_schedule') {
        if (!Array.isArray(s.schedule)) return;
        n.schedule = s.schedule.filter(e => e && typeof e === 'object').map(e => {
            const activity = str(e.activity, 200) ?? '';
            if (!activity) return null;
            const x = { activity };
            const place = str(e.place, 200);
            if (place) x.place = place;
            else {
                const where = str(e.where, 80), near = str(e.near, 200);
                if (where) x.where = where;
                if (near) x.near = near;
            }
            const from = str(e.from, 8), to = str(e.to, 8), importance = str(e.importance, 20);
            if (from) x.from = from;
            if (to) x.to = to;
            if (importance) x.importance = importance;
            return x;
        }).filter(Boolean);
        return;
    }
    if (s.type === 'npc_appearance' || s.type === 'npc_baseline' || s.type === 'npc_appearance_cache') return;
}

/** Stamps on one message that count (a turned-off stamp does not). `swipe` keeps each swipe's own list. */
export function stampsOn(msg, swipe = null) {
    const list = msg?.extra?.[NPC_KEY];
    if (!Array.isArray(list)) return [];
    return list.filter(s => s && typeof s === 'object' && s.off !== true && (swipe == null || s.swipe == null || s.swipe === swipe));
}

/** State after each message through `index`. Cast entries that did not validate are left out. */
export function framesOf(chat, index, cast = [], clock = null) {
    const end = Math.max(-1, Math.min(index ?? -1, (chat?.length ?? 0) - 1));
    const state = new Map();
    for (const rec of cast ?? []) if (rec?.ok && rec.id && !state.has(rec.id)) state.set(rec.id, blankFrom(rec));
    const frames = [];
    for (let i = 0; i <= end; i++) {
        let el = null;
        if (clock) { try { el = clock(i)?.elapsed; } catch { el = null; } }
        for (const s of stampsOn(chat[i])) applyStamp(state, s, i, Number.isFinite(el) ? el : null);
        const flagged = flagsOn(chat[i]).map(normName);
        if (flagged.length) for (const n of state.values()) if (flagged.includes(normName(n.name)) || flagged.includes(n.id)) relUp(n, PLAYER, 'met', i, 'npc flag');
        if (Number.isFinite(el)) for (const n of state.values()) {
            if (n.temps.length) n.temps = n.temps.filter(t => !tempOver(t, el));
            // Drop expired appearance effects (lasts in game minutes from start; start is elapsed seconds).
            n.effects = (n.effects ?? []).filter(e => !(e.lasts > 0 && Number.isFinite(e.start) && el >= e.start + e.lasts * 60));
        }
        const swipe = chat[i]?.swipe_id ?? 0;
        const records = composeRecords(chat, swipe);
        const ownersOf = id => {
            const out = [];
            for (let k = 0; k <= i; k++) for (const s of stampsOn(chat[k])) if (s.id === id && isOwnerStamp(s)) out.push(s);
            return out;
        };
        for (const n of state.values()) {
            if (!readBaselineMap(chat)[n.id]) pinBaseline(chat, n.id, n.body ?? '', n.outfit ?? '');
            const pinned = readBaselineMap(chat)[n.id] ?? { body: n.body ?? '', outfit: n.outfit ?? '' };
            const owners = ownersOf(n.id);
            const view = projectAppearance({ pinned, castLooks: n.castLooks ?? '', body: n.body, looks: n.looks }, owners, records, Number.isFinite(el) ? el : null);
            n.pinned = view.pinned;
            n.lasting = view.lasting;
            n.lastingOps = owners.filter(s => s.committed && !(s.lasts > 0) && s.off !== true);
            n.liveOps = owners.filter(s => s.committed && s.off !== true);
            n.base = { looks: n.castLooks ?? '', body: view.pinned.body, outfit: view.pinned.outfit };
            n.body = view.live.unresolved ? '' : view.live.body;
            n.outfit = view.live.unresolved ? '' : view.live.outfit;
            n.looks = view.live.looks;
            n.appearanceHow = view.live.unresolved ? 'pending' : (view.live.how || 'base');
            n.appearanceKey = view.live.key;
            n.looksHow = view.live.looksHow;
            n.looksKey = view.live.looksKey;
            n.caches = n.caches ?? {};
            n.effects = n.effects ?? [];
        }
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
    return `${e.place ?? ''}|${e.where ?? ''}|${e.from ?? ''}|${e.to ?? ''}|${e.activity ?? ''}`;
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
    const frames = framesOf(chat, end, cast, env?.clock);
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
            if (sched?.offmap) overdue = stayCovers(now, scene, clock) ? '' : offmapAbsentLine(now, sched);
            else if (sched && sched.address !== here) overdue = stayCovers(now, scene, clock) ? '' : overdueNote(now, sched, clock, env);
            else if (now.seen_at && !sched) overdue = stayCovers(now, scene, clock) ? '' : `${now.name}'s hour here has passed.`;
        }
        out.push({ ...publicNpc(now), activity: due?.activity ?? '', place: due?.address ?? here, here, overdue, kind: due?.kind ?? 'scene', known: nameKnown(now, chat, end) });
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
    const frames = framesOf(chat, end, cast, env?.clock);
    if (!frames.length) return [];
    const here = env.playerAt(end);
    const clock = env.clock(end);
    const ids = new Set((present ?? []).map(p => p.id));
    const named = new Set(npcTokenIds(lore));
    const out = [];
    for (const npc of frames[end].values()) {
        if (ids.has(npc.id) || npc.following) continue;
        const sched = scheduleAt(npc, clock, env);
        const stops = (npc.schedule ?? []).filter(e => e && !e.broken && e.place).some(e => resolveSchedulePlace(e.place, env).address === here);
        const nearHere = !!(sched?.offmap && withinNear(here, sched.near));
        if (!stops && !named.has(String(npc.id).toLowerCase()) && !nearHere) continue;
        if (sched?.offmap) { out.push(offmapAbsentLine(npc, sched)); continue; }
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
        id: n.id, name: n.name, line: n.line, manner: n.manner ?? '', voice: n.voice ?? '', looks: n.looks ?? '', body: n.body ?? '', outfit: n.outfit ?? '',
        pinned: n.pinned ? { ...n.pinned } : null,
        lasting: n.lasting ? { ...n.lasting } : null,
        base: { ...(n.base ?? { looks: n.looks ?? '', body: n.body ?? '', outfit: n.outfit ?? '' }) },
        effects: (n.effects ?? []).map(e => ({ ...e, fields: (e.fields ?? []).slice(), text: e.text ? { ...e.text } : undefined })),
        caches: clone(n.caches ?? {}),
        appearanceHow: n.appearanceHow ?? 'base', appearanceKey: n.appearanceKey ?? '',
        looksHow: n.looksHow ?? 'base', looksKey: n.looksKey ?? '',
        unknownAs: n.unknownAs ?? '', rel: clone(n.rel ?? {}), invented: (n.invented ?? []).slice(), deep: clone(n.deep ?? {}),
        facts: [...n.facts, ...(n.temps ?? []).map(t => t.text)], temps: (n.temps ?? []).map(t => ({ ...t })), memory: n.memory.slice(), disposition, fromCast: [...n.fromCast],
        following: n.following ? { ...n.following } : null, from: n.from, seen_at: n.seen_at ? { ...n.seen_at } : null,
        schedule: n.schedule.map(e => ({ ...e })),
    };
}

/** The latest folded NPC, for export and the character bar. */
export function npcAt(chat, index, cast, id, clock = null) {
    const frames = framesOf(chat, index, cast, clock);
    const end = frames.length - 1;
    if (end < 0) return null;
    const n = frames[end].get(id);
    return n ? publicNpc(n) : null;
}

/**
 * When a field change ends, for the inspector: {lasting: true}, or {lasts, until: {day, hour, minute} | null, over}.
 * Worked out from the game clock at the stamp's message (nothing stored): `env.clock(i)` and `env.timeAt(seconds)`.
 */
export function expiryOf(s, i, end, env) {
    const lasts = Number.isFinite(s?.lasts) ? s.lasts : lastsMinutes(s?.lasts);
    if (!lasts) return { lasting: true };
    let start = Number.isFinite(s?.start) ? s.start : null, now = null, until = null;
    try { if (!Number.isFinite(start)) start = env.clock(i)?.elapsed; now = env.clock(end)?.elapsed; } catch { /* no clock */ }
    if (!Number.isFinite(start)) return { lasts, until: null, over: false };
    try { until = env.timeAt?.(start + lasts * 60) ?? null; } catch { until = null; }
    return { lasts, until, over: Number.isFinite(now) && now >= start + lasts * 60 };
}

/**
 * Where everyone stands at the end of the chat, for the map's cast browser: the folded NPC, where they are and why,
 * whether they are in the player's scene, and every stamp about them (with its message index). `cast` is the cast list.
 */
export function npcPlayState(chat, cast, env) {
    const end = (chat?.length ?? 0) - 1;
    if (end < 0) return [];
    const frames = framesOf(chat, end, cast, env?.clock);
    const last = frames[end];
    if (!last) return [];
    let present = new Set();
    try { present = new Set(presentAt(chat, end, cast, env).map(n => n.id)); } catch { /* no position without a clock */ }
    let declined = new Set();
    try { declined = declinesInScene(chat, end, i => env.playerAt(i)); } catch { /* no position */ }
    const stamps = new Map();
    const attempts = new Map();
    chat.forEach((msg, i) => {
        const swipe = msg.swipe_id ?? null;
        const list = msg?.extra?.[NPC_KEY];
        if (Array.isArray(list)) for (const s of list) {
            if (!s || typeof s !== 'object' || typeof s.id !== 'string' || (swipe != null && s.swipe != null && s.swipe !== swipe)) continue;
            if (!stamps.has(s.id)) stamps.set(s.id, []);
            const extra = {};
            if (s.type === 'npc_fact') { extra.field = s.field ?? 'fact'; extra.text = typeof s.text === 'string' ? s.text : ''; }
            else if (s.type === 'npc_appearance' || s.type === 'npc_baseline') {
                extra.intent = s.committed?.intent || s.candidate?.intent || s.intent || '';
                extra.fields = effectFields(s.committed?.fields || s.candidate?.fields || s.fields);
                extra.lasting = !(s.lasts > 0);
                extra.identity = s.identity;
                extra.decisionRev = s.decisionRev ?? 1;
                extra.candidate = s.candidate ? s.candidate.phase : '';
            }
            else if (s.type === 'npc_appearance_cache') continue;
            else if (s.type === 'npc_memory') extra.note = typeof s.note === 'string' ? s.note : '';
            else if (s.type === 'npc_disposition') extra.value = s.value ?? '';
            else if (s.type === 'npc_schedule') extra.count = Array.isArray(s.schedule) ? s.schedule.length : 0;
            stamps.get(s.id).push({ msg: i, type: s.type, off: s.off === true, pending: s.pending === true || !!(s.candidate && !s.committed), where: s.where, place: s.place, owner: s.owner || s.identity?.owner || '', identity: s.identity || null, decisionRev: s.decisionRev ?? 1, summary: stampSummary(s, last.get(s.id)?.name ?? s.name ?? s.id), ...extra, ...(s.type === 'npc_fact' || s.type === 'npc_appearance' || s.type === 'npc_baseline' ? { expiry: expiryOf(s, i, end, env) } : {}) });
        }
        const found = msg?.extra?.[FOUND_KEY];
        if (Array.isArray(found)) for (const f of found) {
            if (!f || (swipe != null && f.swipe != null && f.swipe !== swipe)) continue;
            const id = f.id || '';
            if (!id) continue;
            if (!attempts.has(id)) attempts.set(id, []);
            attempts.get(id).push({ msg: i, ok: !!f.ok, reason: f.reason ?? '', where: f.where ?? '', place: f.place ?? '', source: f.source ?? '' });
        }
    });
    const out = [];
    for (const n of last.values()) {
        let due = null;
        try { due = duePlace(n, end, env); } catch { /* no clock */ }
        out.push({ ...publicNpc(n), held: n.held ? { ...n.held } : null, position: due ? { place: due.address, kind: due.kind, activity: due.activity ?? '' } : null,
            present: present.has(n.id), stamps: stamps.get(n.id) ?? [], foundAttempts: attempts.get(n.id) ?? [], record: exportRecord(n), why: npcWhy(n, end, env, { declined }) });
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
        const near = sched?.near ?? null;
        out.schedule = { entry: i, address: sched?.address ?? null, how: sched?.how ?? null, activity: sched?.activity ?? '',
            offmap: !!sched?.offmap, where: e?.where ?? '', near,
            why: i < 0 ? 'No entry resolves to a place in this world.'
                : sched?.offmap ? `Off the map: ${e?.activity || 'away'}${e?.where ? ` (${e.where})` : ''}. Near ${nearPhrase(near)}.`
                    : sched?.how === 'found' ? `Found in this chat (${e?.where || 'that where'} → ${sched.address}). ${inside ? `Entry ${i + 1} covers ${e.from}–${e.to}.` : !timed ? `Entry ${i + 1} has no times and fills the rest of the day.` : `Entry ${i + 1} is in force.`}`
                        : inside ? `Entry ${i + 1} covers ${e.from}–${e.to}.` : !timed ? `No timed entry covers now; entry ${i + 1} has no times and fills the rest of the day.` : `No entry covers now; entry ${i + 1} is the first that resolves.`,
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
            : due?.kind === 'schedule' ? (out.schedule?.offmap ? out.schedule.why : out.schedule?.why ?? 'On their schedule.')
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
    const frames = framesOf(chat, end, cast, env?.clock);
    const last = frames[end];
    if (!last) return [];
    let present = new Set();
    try { present = new Set(presentAt(chat, end, cast, env).map(n => n.id)); } catch { /* no clock */ }
    const out = [];
    for (const n of last.values()) {
        const w = npcWhy(n, end, env);
        let due = null; try { due = duePlace(n, end, env, { useRoll: true }); } catch { /* no clock */ }
        const pointsHere = (n.schedule ?? []).some(e => e && !e.broken && e.place && (resolveSchedulePlace(e.place, env).address ?? e.place) === place)
            || (n.schedule ?? []).some(e => e && !e.broken && !e.place && withinNear(place, nearOf(e, env)))
            || (n.seen_at && !n.seen_at.broken && (resolveSchedulePlace(n.seen_at.place, env).address ?? n.seen_at.place) === place) || n.held?.place === place;
        const here = due?.address === place;
        if (!here && !pointsHere && !present.has(n.id)) continue;
        let reason = w.reason;
        if (!here && pointsHere) {
            if (n.following) reason = `Not here: following ${n.following.who === PLAYER ? 'the player' : n.following.who}.`;
            else if (w.held?.active && n.held.place !== place) reason = 'Not here: told to stay somewhere else.';
            else if (w.sighting?.active && w.sighting.resolved === place && !w.sighting.wouldShow) reason = `No-show today: rolled ${w.sighting.used}, needed under ${w.sighting.now}${w.sighting.sought ? ' (with a by-name roll)' : ''}.`;
            else if (w.schedule?.offmap) reason = `Not here: ${offmapAbsentLine(n, { activity: w.schedule.activity, where: w.schedule.where, near: w.schedule.near })}`;
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
    let asked = [];
    try { asked = askedLoreNames(chat, before, i => env.playerAt(i)); } catch { asked = []; }
    const tiers = npcTiers(present, focus, { chat, index: before, said: ui >= 0 ? chat[ui]?.mes ?? '' : '', asked });
    const slices = npcSlices(present, focus, { tiers, pc: env?.pc || 'the player' });
    const listed = present.map(p => ({ id: p.id, name: p.name, depth: focus?.id === p.id && focus.depth !== 'present' ? focus.depth : 'present',
        memories: focus?.id === p.id && focus.depth && focus.depth !== 'present' ? [...(p.memory ?? [])] : [],
        tier: tiers[p.id].tier, why: tiers[p.id].why, topical: tiers[p.id].topical ? tiers[p.id].topicalWhy : '',
        known: p.known?.known !== false, nameWhy: p.known?.reason ?? '', shownAs: p.known?.known === false ? p.unknownAs : p.name }));
    let comings = [];
    try { comings = comingsAndGoings(chat, before, cast, env); } catch { comings = []; }
    return { reply, user: ui, focus: focus ? { id: focus.id ?? null, depth: focus.depth ?? 'present', stored: !!(stored && stored.depth) } : null, listed, comings, ...slices };
}

const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/**
 * Saved people who came or went between the last narrator reply and `end` while the player stayed put and game time passed:
 * ['[14:20] Hesk arrives.', '[15:00] Maren leaves.']. Only people outside the scene come and go (presentAt keeps anyone
 * already in the scene, so they never snap back to their schedule). The time is the schedule's start (arrival) or end
 * (departure) when it falls inside the wait, else the time now.
 */
export function comingsAndGoings(chat, end, cast, env) {
    let p = -1;
    for (let i = Math.min(end, (chat?.length ?? 0) - 1); i >= 0; i--) if (chat[i] && !chat[i].is_user && i < end) { p = i; break; }
    if (p < 0) return [];
    let before, now, c0, c1;
    try {
        if (env.playerAt(p) !== env.playerAt(end)) return [];
        c0 = env.clock(p); c1 = env.clock(end);
        if (!(c1?.elapsed > c0?.elapsed)) return [];
        before = presentAt(chat, p, cast, env); now = presentAt(chat, end, cast, env);
    } catch { return []; }
    const was = new Set(before.map(n => n.id)), is = new Set(now.map(n => n.id));
    const span = Math.round((c1.elapsed - c0.elapsed) / 60);
    const inside = m => m != null && ((m - (c0.minutes ?? 0)) % 1440 + 1440) % 1440 <= span;
    const at = m => `[${hhmm(inside(m) ? m : c1.minutes ?? 0)}]`;
    const shown = n => (n.known?.known === false && n.unknownAs ? n.unknownAs : n.name);
    const lines = [];
    for (const n of now) if (!was.has(n.id)) lines.push(`${at(scheduleAt(n, c1, env)?.entry?.fromMin)} ${shown(n)} arrives.`);
    for (const n of before) if (!is.has(n.id)) lines.push(`${at(scheduleAt(n, c0, env)?.entry?.toMin)} ${shown(n)} leaves.`);
    // Appearance effects that expired while the person was still in the scene.
    const beforeMap = new Map(before.map(n => [n.id, n]));
    for (const n of now) {
        const prev = beforeMap.get(n.id);
        if (!prev) continue;
        const still = new Set((n.effects ?? []).map(e => `${String(e.intent).toLowerCase()}|${effectFields(e.fields).join('+')}`));
        for (const e of (prev.effects ?? [])) {
            if (!e.lasts) continue;
            const key = `${String(e.intent).toLowerCase()}|${effectFields(e.fields).join('+')}`;
            if (still.has(key)) continue;
            const expiryMin = Number.isFinite(e.start) && e.lasts
                ? Math.round((e.start + e.lasts * 60) / 60) % 1440
                : (c1.minutes ?? 0);
            lines.push(`${at(expiryMin)} ${shown(n)}'s ${e.intent} fades (expired ${hhmm(expiryMin)}).`);
        }
    }
    return lines.sort();
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

const LOOK_BRACKET_RE = /\[\s*look\b/i;

/**
 * Whether actor `who` (the player unless given) knows NPC n's name after message `index`, and why. Per actor, never per
 * party. Known when their relationship record (rel) says 'named' (remembered through [remember], an npc_name stamp from
 * [ws_flag: name | Name], [name] or /ws-name, or the player's /ws-know edit), or the card has no unknownAs (nothing
 * else to call them). Never inferred from chat text.
 */
export function nameKnown(n, chat = [], index = -1, who = PLAYER) {
    const r = relOf(n, who);
    if (r.state === 'named') return { known: true, reason: `known: ${r.by}` };
    if (!n?.unknownAs) return { known: true, reason: 'known: no unknownAs on the card' };
    return { known: false, reason: `not known: shown as "${n.unknownAs}"` };
}

/** The lore requests in this scene up to `index` that name no place (e.g. [lore] Hesk or [ws_flag: lore | Hesk]): their asked names. */
export function askedLoreNames(chat, index, playerAt) {
    const end = Math.max(0, Math.min(index ?? 0, (chat?.length ?? 1) - 1));
    if (!chat?.length) return [];
    const out = [];
    for (let i = sceneStartOf(chat, end, playerAt); i <= end; i++) for (const r of loreRequestsOn(chat[i])) if (!r.level && r.place) out.push(r.place);
    return out;
}

/**
 * Feeding tiers for the people present: {id: {tier, why, topical, topicalWhy}}.
 * - 'present' (background): name or unknownAs, appearance.summary, personality.summary, current activity.
 * - 'engaged': looked at, in focus (talking), following the player, or flagged by the narrator ([ws_flag: npc | Name])
 *   in one of the last `recent` replies: adds body, outfit, manner, speech, disposition and memory highlights.
 * - topical: history, only when a lore request in this scene names them (`asked`, from askedLoreNames).
 */
export function npcTiers(present, focus, { chat = [], index = -1, said = '', asked = [], recent = 3 } = {}) {
    const out = {};
    const flagged = [];
    for (let i = Math.min(index, (chat?.length ?? 0) - 1), seen = 0; i >= 0 && seen < recent; i--) {
        const m = chat[i];
        if (!m || m.is_system || m.is_user) continue;
        seen++;
        flagged.push(...flagsOn(m));
    }
    const names = p => [p.name, p.id, p.unknownAs].filter(Boolean);
    const hits = (list, p) => list.some(x => names(p).some(nm => normName(x) === normName(nm) || nameIn(x, nm)));
    for (const p of present ?? []) {
        const focused = focus?.id === p.id && focus.depth && focus.depth !== 'present';
        let why = '';
        if (focused && (LOOK_AT_RE.test(said) || LOOK_BRACKET_RE.test(said))) why = 'the player looked at them';
        else if (focused) why = 'in active interaction (in focus)';
        else if (p.following) why = 'following the player';
        else if (hits(flagged, p)) why = 'the narrator flagged them in a recent reply';
        const topical = !!p.deep?.history && hits(asked, p);
        out[p.id] = { tier: why ? 'engaged' : 'present', why: why || 'in the background', topical, topicalWhy: topical ? 'a lore request named them' : '' };
    }
    return out;
}

/**
 * Prompt slices by tier (see npcTiers). Everyone present gets one line: label, appearance.summary, personality.summary,
 * activity. Engaged people add body, outfit, manner, speech, disposition and their last few memories; topical adds history.
 * The focus slice keeps facts, the full memory and (when deep) secrets and relationships.
 */
const shownName = p => (p.known?.known === false && p.unknownAs ? p.unknownAs : p.name);
/** 'Met Joe but doesn't know him by name.': what this person knows of the player character. */
export function relLine(p, pc = 'the player') {
    const st = relOf(p).state;
    if (st === 'named') return `Knows ${pc} by name.`;
    if (st === 'met') return `Met ${pc} but doesn't know ${pc} by name.`;
    return `Has not met ${pc} before.`;
}
/** Above the memories when the name is unknown to them: memories use real names, but they must not say one they don't know. */
const nameGuard = (p, pc) => (relOf(p).state === 'named' ? [] : [`(Their memories use real names for clarity; ${shownName(p)} does not know the name ${pc} and must not say it.)`]);

export function npcSlices(present, focus = {}, { tiers = null, pc = 'the player' } = {}) {
    const list = present ?? [];
    if (!list.length) return { npcs_present: '', npc_focus: '' };
    const tierOf = p => tiers?.[p.id] ?? { tier: focus?.id === p.id ? 'engaged' : 'present' };
    const lines = list.map(p => {
        const t = tierOf(p);
        const bits = [`${label(p)}:`];
        if (p.looks) bits.push(`Looks: ${p.looks}.`);
        bits.push(`Demeanor: ${p.line}`);
        if (p.activity) bits.push(`Now: ${p.activity}.`);
        if (p.overdue) bits.push(p.overdue);
        if (t.tier === 'engaged') {
            if (p.body) bits.push(`Body: ${p.body}`);
            if (p.outfit) bits.push(`Wearing: ${p.outfit}`);
            if (p.manner) bits.push(`Manner: ${p.manner}`);
            if (p.voice) bits.push(`Speech: ${p.voice}`);
            const d = dispositionLine(p).trim();
            if (d) bits.push(d);
            bits.push(relLine(p, pc));
            if (p.memory?.length && focus?.id !== p.id) bits.push(...nameGuard(p, pc), `Remembers: ${p.memory.slice(-3).join('; ')}.`);
        }
        if (t.topical) bits.push(`History: ${p.deep.history}`);
        return bits.join(' ').replace(/\.\./g, '.');
    });
    const who = focus?.id ? list.find(p => p.id === focus.id) : null;
    let npc_focus = '';
    if (who && focus.depth && focus.depth !== 'present') {
        const bits = [`${shownName(who)}, in focus.`, relLine(who, pc)];
        if (who.facts?.length) bits.push(`Known facts: ${who.facts.join('; ')}`);
        if (who.memory?.length) bits.push(...nameGuard(who, pc), `Memory: ${who.memory.map(m => `- ${m}`).join('\n')}`);
        if (focus.depth === 'deep' && who.deep) {
            if (who.deep.secrets?.length) bits.push(`Secrets: ${who.deep.secrets.join('; ')}`);
            if (who.deep.relationships && Object.keys(who.deep.relationships).length) bits.push(`Relationships: ${Object.entries(who.deep.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
        npc_focus = bits.join('\n');
    }
    return { npcs_present: lines.join('\n'), npc_focus };
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
    diffLine('name', a.name ?? '', b.name ?? '', lines);
    diffLine('unknownAs', a.unknownAs ?? '', b.unknownAs ?? '', lines);
    for (const k of ['summary', 'manner', 'speech']) diffLine(`personality.${k}`, a.personality?.[k] ?? '', b.personality?.[k] ?? '', lines);
    for (const k of ['summary', 'body', 'outfit']) diffLine(`appearance.${k}`, a.appearance?.[k] ?? '', b.appearance?.[k] ?? '', lines);
    diffLine('history', a.history ?? '', b.history ?? '', lines);
    const whos = new Set([...Object.keys(a.disposition ?? {}), ...Object.keys(b.disposition ?? {})]);
    const disp = d => (d ? `${d.value}${d.reason ? ` (${d.reason})` : ''}` : '');
    for (const who of [...whos].sort()) diffLine(`disposition.${who}`, disp(a.disposition?.[who]), disp(b.disposition?.[who]), lines);
    const list = xs => (xs ?? []).join('; ');
    diffLine('facts', list(a.facts), list(b.facts), lines);
    diffLine('memory', list(a.memory), list(b.memory), lines);
    diffLine('deep.secrets', list(a.deep?.secrets), list(b.deep?.secrets), lines);
    const rels = new Set([...Object.keys(a.deep?.relationships ?? {}), ...Object.keys(b.deep?.relationships ?? {})]);
    for (const k of [...rels].sort()) diffLine(`deep.relationships.${k}`, a.deep?.relationships?.[k] ?? '', b.deep?.relationships?.[k] ?? '', lines);
    diffLine('schedule', JSON.stringify(a.schedule ?? []), JSON.stringify(b.schedule ?? []), lines);
    diffLine('seen_at', JSON.stringify(a.seen_at ?? null), JSON.stringify(b.seen_at ?? null), lines);
    const invented = Array.isArray(after?.invented) ? after.invented.slice() : [];
    const text = lines.map(l => `${l.field}\n- ${l.from || '(empty)'}\n+ ${l.to || '(empty)'}`).join('\n')
        + (lines.length && invented.length ? `\n\nMade up when remembered (not in the story; edit before saving if wrong):\n${invented.map(x => `- ${x}`).join('\n')}` : '');
    return { changed: lines.length > 0, lines, text, invented };
}

/** Diff a cast file against what Update may write. Temporary appearance and temporary facts are not in the diff. */
export function fileDiff(before, npc) {
    const rec = authorRecord(npc);
    if (!rec) return recordDiff(before, npc ?? {});
    const after = Array.isArray(npc?.invented) && npc.invented.length ? { ...rec, invented: npc.invented.slice() } : rec;
    return recordDiff(before, after);
}

export const NPC_FLAG_KEY = 'worldscrawl_npc_flags';

/** The narrator's [ws_flag: npc | Name] tags: the names come back, the text without the tags. */
export const NPC_FLAG_TAG = /\s*\[ws_flag:\s*npc\s*\|\s*([^\]|]{1,60})\]/gi;

export function takeNpcFlags(text) {
    const names = [];
    const cleaned = String(text ?? '').replace(NPC_FLAG_TAG, (_all, n) => { const v = n.trim(); if (v) names.push(v); return ''; });
    return { names, text: cleaned };
}

/** The narrator's [ws_flag: name | Name] tags (the player just learned that person's name): the names, the text without them. */
export const NAME_FLAG_TAG = /\s*\[ws_flag:\s*name\s*\|\s*([^\]|]{1,60})\]/gi;

export function takeNameFlags(text) {
    const names = [];
    const cleaned = String(text ?? '').replace(NAME_FLAG_TAG, (_all, n) => { const v = n.trim(); if (v) names.push(v); return ''; });
    return { names, text: cleaned };
}

/** The narrator's [ws_flag: found | Name] tags: the names, the text without them. */
export const FOUND_FLAG_TAG = /\s*\[ws_flag:\s*found\s*\|\s*([^\]|]{1,80})\]/gi;

export function takeFoundFlags(text) {
    const names = [];
    const cleaned = String(text ?? '').replace(FOUND_FLAG_TAG, (_all, n) => { const v = n.trim(); if (v) names.push(v); return ''; });
    return { names, text: cleaned };
}

/** The saved person a name flag means: exact name or id first, then a name contained either way. Null when none or several. */
export function npcForName(npcs, name) {
    const key = normName(name);
    const list = [...(npcs ?? [])];
    const exact = list.filter(n => normName(n.name) === key || n.id === key);
    if (exact.length === 1) return exact[0];
    const loose = list.filter(n => nameIn(name, n.name) || nameIn(n.name, name));
    return loose.length === 1 ? loose[0] : null;
}

/** Names the narrator flagged on message m (the shown swipe). */
/** The saved person a tag or tool call means: its id when that id is saved, else a saved person by that name; null when neither. */
export function npcTarget(npcs, idOrName) {
    const key = String(idOrName ?? '').trim();
    if (!key) return null;
    const list = [...(npcs ?? [])];
    if (list.some(n => n.id === key)) return key;
    return npcForName(list, key.replace(/_/g, ' '))?.id ?? null;
}
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

const TAG_KIND = { fact: 'npc_fact', memory: 'npc_memory', disposition: 'npc_disposition', leave: 'npc_leave', staying: 'npc_staying', follow: 'npc_follow', stay: 'npc_stay', seek: 'npc_seek', appearance: 'npc_appearance' };

/** One [ws_npc: ...] body -> a stamp, or null when it does not parse. */
export function parseNpcTag(body) {
    const p = String(body ?? '').split('|').map(s => s.trim());
    const kind = (p[0] ?? '').toLowerCase();
    const type = TAG_KIND[kind];
    const id = p[1] ?? '';
    if (!type || !NPC_ID.test(id)) return null;
    if (type === 'npc_fact') {
        const rest = p.slice(2), lasts = rest.length > 1 ? lastsMinutes(rest.at(-1)) : null;
        const text = (lasts ? rest.slice(0, -1) : rest).join(' | ').trim();
        return text ? { type, id, field: 'fact', text, ...(lasts ? { lasts } : {}) } : null;
    }
    if (type === 'npc_memory') { const note = p.slice(2).join(' | ').trim(); return note ? { type, id, note } : null; }
    if (type === 'npc_disposition') {
        const value = matchEnum(p[2], DISPOSITIONS);
        if (!value) return null;
        return { type, id, who: PLAYER, value, reason: p.slice(3).join(' | ').trim() };
    }
    if (type === 'npc_follow') return { type, id, who: NPC_ID.test(p[2] ?? '') ? p[2] : PLAYER };
    if (type === 'npc_seek') return { type, id };
    if (type === 'npc_appearance') {
        // appearance|id|intent|fields?|lasts?  — fields omit/"all" → all three; lasts omit → lasting.
        // An empty intent still parses: the reply handler rejects it when nothing changed, instead of dropping it.
        const intent = (p[2] ?? '').trim();
        const rest = p.slice(3);
        let lasts = null, fields = null;
        if (rest.length) {
            const maybeLasts = lastsMinutes(rest.at(-1));
            if (maybeLasts) { lasts = maybeLasts; rest.pop(); }
            if (rest.length) fields = rest.join('|');
        }
        return { type, id, intent, ...(fields ? { fields } : {}), ...(lasts ? { lasts } : {}) };
    }
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

/**
 * JSON from the remember question: {name, unknownAs, personality: {summary, manner, speech}, appearance: {summary, body,
 * outfit}, history, disposition: {value, reason}, facts: [], invented: []}. Name and personality.summary are required.
 * `invented` lists details the model made up to fill gaps (not in the story), shown when the card is reviewed.
 * Returned flat, in the stamp's field names: {name, line, manner, voice, looks, body, outfit, history, unknownAs, ...}.
 */
export function readRememberAnswer(ans) {
    if (!isObj(ans)) return null;
    const name = str(ans.name, 80);
    const pers = isObj(ans.personality) ? ans.personality : {};
    const app = isObj(ans.appearance) ? ans.appearance : {};
    const line = str(pers.summary, 400);
    if (!name || !line) return null;
    const out = { name, line, manner: str(pers.manner, 400) ?? '', voice: str(pers.speech, 400) ?? '',
        looks: str(app.summary, 240) ?? '', body: str(app.body, APPEARANCE_MAX) ?? '', outfit: str(app.outfit, APPEARANCE_MAX) ?? '',
        history: str(ans.history, HISTORY_MAX) ?? '', unknownAs: str(ans.unknownAs, 80) ?? '',
        facts: cleanList(ans.facts, 8), invented: cleanList(ans.invented, 12) };
    const d = isObj(ans.disposition) ? ans.disposition : typeof ans.disposition === 'string' ? { value: ans.disposition } : null;
    const value = d ? matchEnum(d.value, DISPOSITIONS) : null;
    if (value) out.disposition = { value, reason: str(d.reason, 240) ?? '' };
    return out;
}

/** A one-line description of one stamp, for the "Character changed here" bar. */
export function stampSummary(s, name = '') {
    const who = name || s?.id || 'Someone';
    if (!s) return who;
    if (s.type === 'npc_fact') return `${who}: ${s.text}${lastsMinutes(s.lasts) ? ` (for ${lastsText(lastsMinutes(s.lasts))})` : ''}`;
    if (s.type === 'npc_memory') return `${who}: remembered — ${s.note}`;
    if (s.type === 'npc_disposition') return `${who}: ${s.value}${s.reason ? ` (${s.reason})` : ''}`;
    if (s.type === 'npc_follow') return `${who} comes along`;
    if (s.type === 'npc_stay') return `${who} stays behind`;
    if (s.type === 'npc_leave') return `${who} leaves`;
    if (s.type === 'npc_staying') return `${who} is staying`;
    if (s.type === 'npc_create') return `${who} remembered`;
    if (s.type === 'npc_name') return `${s.who && s.who !== PLAYER ? s.who : 'The player'} learned ${who}'s name`;
    if (s.type === 'npc_rel') return `${s.who && s.who !== PLAYER ? s.who : 'The player'} set ${who} to ${REL_TEXT[s.state] ?? s.state}`;
    if (s.type === 'npc_found') return `${who} found${s.where ? ` (${s.where})` : ''} at ${s.place}`;
    if (s.type === 'npc_appear') return `${who} is here`;
    if (s.type === 'npc_seek') return `Looking for ${who}`;
    if (s.type === 'npc_appearance' || s.type === 'npc_baseline') {
        if (s.candidate && !s.committed) return `${who}: appearance proposal`;
        const intent = s.committed?.intent || s.committed?.text || s.intent || 'appearance';
        const lasts = Number.isFinite(s.lasts) ? s.lasts : lastsMinutes(s.lasts);
        return `${who}: appearance — ${intent}${lasts ? ` (for ${lastsText(lasts)})` : ''}`;
    }
    if (s.type === 'npc_appearance_cache') return '';
    if (s.type === 'npc_schedule') {
        const n = Array.isArray(s.schedule) ? s.schedule.length : 0;
        return `${who}: schedule (${n} ${n === 1 ? 'entry' : 'entries'})`;
    }
    return who;
}

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

/** The part of an address a lore level covers: "riverton:drowned_rat/common_room" -> region "riverton", subregion "riverton:drowned_rat", room the whole. */
export function loreScope(address, level) {
    const a = String(address ?? '');
    if (level === 'region') return a.includes(':') ? a.slice(0, a.indexOf(':')) : a;
    if (level === 'subregion') return a.includes('/') ? a.slice(0, a.lastIndexOf('/')) : a;
    return a;
}

/**
 * The lore to feed at message `index`: chain entries (innermost first) that were asked for while the player has been
 * inside them. A request for a level stays active as long as the player stays inside that level (room: the same room;
 * subregion: anywhere in it; region: anywhere in it), looking back until the player was last outside it. Requests with
 * level '' (nothing matched) keep the exact-room, this-scene rule. `extra` are requests not stamped yet (this turn's [lore]).
 */
export function activeLore(chat, index, chain, playerAt, extra = []) {
    if (!chain?.length) return [];
    const n = chat?.length ?? 0;
    const end = Math.max(0, Math.min(index ?? 0, n - 1));
    const here = playerAt(end);
    const levels = new Set();
    const add = r => { for (const c of (r.level ? chain.filter(c => c.level === r.level) : loreFor(chain, r.place))) levels.add(c.level); };
    for (const r of extra) add(r);
    for (const c of chain) {
        const scope = loreScope(here, c.level);
        for (let i = end; i >= 0 && i < n; i--) {
            if (loreScope(playerAt(i), c.level) !== scope) break;
            if (loreRequestsOn(chat[i]).some(r => r.level === c.level && (!r.address || loreScope(r.address, c.level) === scope))) { levels.add(c.level); break; }
        }
    }
    const from = n ? sceneStartOf(chat, end, playerAt) : 0;
    for (let i = from; i <= end && i < n; i++) for (const r of loreRequestsOn(chat[i])) if (!r.level && (!r.address || r.address === here)) add(r);
    // Stub-region lore (level "elsewhere") stays for the scene: the player cannot stand inside a place that is not on the map.
    const elseIds = new Set();
    const stub = r => { if (r?.level === 'elsewhere' && r.address) elseIds.add(r.address); };
    for (const r of extra) stub(r);
    for (let i = from; i <= end && i < n; i++) for (const r of loreRequestsOn(chat[i])) stub(r);
    return chain.filter(c => levels.has(c.level) || (c.level === 'elsewhere' && elseIds.has(c.id ?? c.address)));
}
