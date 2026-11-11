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


/** A clean cast file from a played NPC (base fields plus facts, memory and disposition). Following stays in the chat. */
export function exportRecord(npc) {
    if (!npc?.id) return null;
    // A file-shaped record (nested personality / appearance, top-level history) reads as its folded form.
    if (isObj(npc.personality)) {
        const p = npc.personality, a = isObj(npc.appearance) ? npc.appearance : {};
        npc = { ...npc, line: p.summary, manner: p.manner, voice: p.speech, looks: a.summary, body: a.body, outfit: a.outfit,
            deep: { ...(npc.deep ?? {}), ...(npc.history ? { history: npc.history } : {}) } };
    }
    const out = { id: npc.id, name: npc.name };
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
    else if (npc.seen_at && !npc.seen_at.broken) out.seen_at = { place: npc.seen_at.place, hour: npc.seen_at.hour, chance: npc.seen_at.chance ?? 0.5 };
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
// knowledge, fed only when the narrator asks with [ws_flag: lore | Place] (or the ws_flag tool's "lore" action) or the
// player writes [lore]. The narrator always sees a one-line index of the lore on file. Cast NPCs are written as
// {{npc:castId}} tokens in lore and descriptions; the engine renders them as names before SillyTavern's macros run.
export const NPC_TOKEN = /\{\{\s*npc\s*:\s*([^{}\s]*)\s*\}\}/gi;

/** The cast ids in a text's {{npc:id}} tokens, in order, unique. */
export const npcTokenIds = text => [...new Set([...String(text ?? '').matchAll(NPC_TOKEN)].map(m => m[1].toLowerCase()))];
