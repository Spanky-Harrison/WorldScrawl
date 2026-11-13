// NPC record checks and the near-index: server only (cast files). The rest of the NPC code is in shared/npc.mjs
// (both sides) and extension/npc.mjs (play).
import { APPEARANCE_MAX, DISPOSITIONS, HISTORY_MAX, MEMORY_CAP, NPC_ID, isMight, isNowhere, isObj, matchEnum, parseHm, readMightEntry, resolveNear, str, windowsOverlap } from './shared/npc.mjs';

export { parseHm };

export const DISPOSITION_ALL = ['unknown', ...DISPOSITIONS];

export const IMPORTANCE = ['low', 'normal', 'high'];

/**
 * One cast record. Never throws. `places` (a Set of addresses), when given, marks a schedule
 * place that is not in the world as broken. A place that exists here can still expire later;
 * that is decided when the schedule is resolved, not here.
 */
export function validateRecord(raw, { file = 'npc', places = null, nearIndex = null } = {}) {
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
    const sub = (obj, key, max, label) => {
        const v = obj?.[key];
        if (v == null || v === '') return '';
        const s = str(v, max);
        if (!s) fail(`${file}: "${label}" must be a short string`);
        return s ?? '';
    };
    if (raw.personality != null && !isObj(raw.personality)) fail(`${file}: "personality" must be {summary, manner, speech}`);
    const pers = isObj(raw.personality) ? raw.personality : {};
    // personality.summary is the card's one-line identity (kept as `line` inside; an old top-level "line" still loads).
    const line = sub(pers, 'summary', 400, 'personality.summary') || str(raw.line, 400);
    if (!line) fail(`${file}: "personality.summary" is required (a few words: stern, watchful, sharp-tongued)`);
    // Legacy top-level manner / voice load into personality.manner / personality.speech.
    const manner = sub(pers, 'manner', 400, 'personality.manner') || sub(raw, 'manner', 400, 'manner');
    const voice = sub(pers, 'speech', 400, 'personality.speech') || sub(raw, 'voice', 400, 'voice');
    let looks = '', body = '', outfit = '';
    if (typeof raw.appearance === 'string') body = sub(raw, 'appearance', APPEARANCE_MAX, 'appearance'); // the phase-1 string loads as the body
    else if (isObj(raw.appearance)) {
        looks = sub(raw.appearance, 'summary', 240, 'appearance.summary');
        body = sub(raw.appearance, 'body', APPEARANCE_MAX, 'appearance.body');
        outfit = sub(raw.appearance, 'outfit', APPEARANCE_MAX, 'appearance.outfit');
    } else if (raw.appearance != null) fail(`${file}: "appearance" must be {summary, body, outfit}`);
    const history = sub(raw, 'history', HISTORY_MAX, 'history');
    const unknownAs = sub(raw, 'unknownAs', 80, 'unknownAs');
    // Other names for the same person (nicknames, a short form). Masked like the name until it is learned.
    let aliases = [];
    if (raw.aliases != null) {
        if (!Array.isArray(raw.aliases)) fail(`${file}: "aliases" must be a list of names`);
        else aliases = raw.aliases.map(a => str(a, 80)).filter(Boolean).slice(0, 12);
    }
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
        else raw.schedule.forEach((e, i) => schedule.push(isObj(e) && Array.isArray(e.might) ? validateMight(e, `${file} schedule[${i}]`, places, note, nearIndex) : validateEntry(e, `${file} schedule[${i}]`, places, note, nearIndex)));
        overlapNotes(schedule, `${file} schedule`, note);
    }
    // The old one-off sighting is gone; might-be-at entries replace it.
    if (raw.seen_at !== undefined) note(`${file}: unknown field "seen_at" (ignored; use a "might" schedule entry instead)`);
    const deep = cleanDeep(raw.deep, file, fail);
    if (history) deep.history = history;
    const facts = Array.isArray(raw.facts) ? raw.facts.map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean).slice(0, 24) : [];
    const memory = Array.isArray(raw.memory) ? raw.memory.map(f => (typeof f === 'string' ? f.trim() : isObj(f) ? str(f.note, 240) : '')).filter(Boolean).slice(-MEMORY_CAP) : [];
    const ok = errors.length === 0 && !!id && !!name && !!line;
    return { ok, id, name: name ?? '', line: line ?? '', manner, voice, looks, body, outfit, unknownAs, aliases, disposition, schedule, deep, facts, memory, problems, from: 'cast' };
}

function validateEntry(e, where, places, fail, nearIndex = null) {
    if (!isObj(e)) { fail(`${where}: must be an object`); return { place: '', activity: '', broken: true, problem: 'not an object' }; }
    const place = str(e.place, 200) ?? '';
    const activity = str(e.activity, 200) ?? '';
    const whereLabel = str(e.where, 80) ?? '';
    const near = str(e.near, 200) ?? '';
    const problems = [];
    // A place puts them on the map. No place is a placeless entry: off the map, with activity required.
    if (!activity) problems.push('activity is required');
    if (!place && !activity) problems.push('activity is required');
    let fromMin = null, toMin = null, from = null, to = null;
    if (e.from != null && String(e.from).trim()) {
        fromMin = parseHm(e.from);
        if (fromMin == null) problems.push('from must look like "08:00"');
        else from = String(e.from).trim();
    }
    if (e.to != null && String(e.to).trim()) {
        toMin = parseHm(e.to);
        if (toMin == null) problems.push('to must look like "17:00"');
        else to = String(e.to).trim();
    }
    let importance = null;
    if (e.importance != null && String(e.importance).trim()) {
        importance = matchEnum(e.importance, IMPORTANCE);
        if (!importance) problems.push('importance must be low, normal or high');
    }
    let nearNote = '';
    if (!place && near && nearIndex) {
        const resolved = resolveNear(near, nearIndex);
        if (resolved.kind === 'text' && resolved.warn === 'typo') {
            nearNote = 'probably a typo';
            fail(`${where}: near "${near}" matches no place and no stub region (a single word; probably a typo)`);
        } else if (resolved.kind === 'text') nearNote = 'not in the list';
    }
    let broken = problems.length > 0;
    let problem = problems.join('; ');
    if (!broken && place && places && !places.has(place)) {
        broken = true;
        problem = 'place is not in this world';
        fail(`${where}: ${problem} (${place})`);
    } else if (broken) fail(`${where}: ${problem}`);
    return {
        ...(place ? { place } : {}), activity,
        ...(!place && whereLabel ? { where: whereLabel } : {}),
        ...(!place && near ? { near } : {}),
        ...(nearNote ? { nearNote } : {}),
        ...(from ? { from } : {}), ...(to ? { to } : {}), fromMin, toMin,
        ...(importance ? { importance } : {}), ...(broken ? { broken: true, problem } : {}),
    };
}

/**
 * What one might option is in this world: a room, an area (subregion or region), a stub place, plain off-map text, or nowhere.
 * An address-like option (with a colon) that is on no map is `unknown`. Without a place list everything but nowhere is unchecked.
 */
export function mightOptionKind(text, places = null, nearIndex = null) {
    if (isNowhere(text)) return 'nowhere';
    if (places?.has?.(text) || nearIndex?.rooms?.has?.(text)) return 'room';
    if (nearIndex?.subs?.has?.(text) || nearIndex?.regions?.has?.(text)) return 'area';
    if (nearIndex?.stubs?.has?.(text)) return 'stub';
    if (!places && !nearIndex) return 'unchecked';
    return text.includes(':') ? 'unknown' : 'text';
}

/** A might-be-at entry (shared readMightEntry plus the world checks): an unknown option is dropped (its odds become away) with a note; all unknown breaks it. */
function validateMight(e, where, places, note, nearIndex = null) {
    const { entry, problems, warnings } = readMightEntry(e);
    for (const w of warnings) note(`${where}: ${w}`);
    if (!entry.broken && (places || nearIndex)) {
        const unknown = entry.options.filter(o => mightOptionKind(o.text, places, nearIndex) === 'unknown');
        for (const o of unknown) note(`${where}: might option "${o.text}" is not a place in this world (dropped; that share is away)`);
        for (const o of entry.options) if (mightOptionKind(o.text, places, nearIndex) === 'text' && !/\s/.test(o.text)) note(`${where}: might option "${o.text}" matches no place and no stub region (a single word; probably a typo), so it is read as off the map`);
        if (unknown.length) {
            for (const o of unknown) o.dropped = true;
            if (unknown.length === entry.options.length) Object.assign(entry, { broken: true, problem: 'no option is a place in this world' });
        }
    }
    if (entry.broken) note(`${where}: ${entry.problem}`);
    return entry;
}

/** A load note for each hand-written overlap between a might block and another timed entry (the might block wins). */
function overlapNotes(schedule, where, note) {
    const timed = schedule.map((e, i) => ({ e, i })).filter(({ e }) => e && !e.broken && e.fromMin != null && e.toMin != null);
    for (const a of timed) for (const b of timed) {
        if (b.i <= a.i || !(isMight(a.e) || isMight(b.e))) continue;
        if (windowsOverlap(a.e.fromMin, a.e.toMin, b.e.fromMin, b.e.toMin)) note(`${where}[${a.i}] and [${b.i}] overlap (${a.e.from}–${a.e.to}, ${b.e.from}–${b.e.to}); the might block is used there`);
    }
}

function cleanDeep(raw, file, fail) {
    if (raw == null) return {};
    if (!isObj(raw)) { fail(`${file}: "deep" must be an object`); return {}; }
    const out = {};
    if (raw.history != null) {
        const h = str(raw.history, HISTORY_MAX);
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

/** Index for resolveNear from a loaded world (rooms, subregions, regions, stub regions). */
export function nearIndexFrom(world) {
    if (!world?.locations) return null;
    const rooms = new Set(world.locations.keys());
    const subs = new Set(world.subregions?.keys?.() ?? []);
    const regions = new Set(world.regions?.keys?.() ?? []);
    const stubs = world.elsewhere instanceof Map ? world.elsewhere : new Map();
    const nameOf = a => world.locations.get(a)?.name || world.subregions?.get(a)?.name || world.regions?.get(a)?.name || stubs.get(a)?.name || a;
    return { rooms, subs, regions, stubs, nameOf, exists: a => rooms.has(a), relocate: {} };
}
