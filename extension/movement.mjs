// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { PLAYER, LOC_KEY, playerAddress, placeStamp } from './actors.mjs';
import { followersAt } from './npc.mjs';
import { revealsDestination } from './shared.mjs';
import { PLAIN_DIRECTIONS, addNotice, withArticle } from './brackets.mjs';
import { worldSeed } from './clock.mjs';
import { api, currentLocation, isStuck, stuckWhy } from './doors.mjs';
import { exitsText, fetchLocationCached, fetchRaw, newRoom, primeCache, renderAllExits, warmRooms } from './footer.mjs';
import { DEFAULTS, MOVE_KEY, ctx, engineBusy, goTarget, revealedAddresses, settings } from './index.js';
import { mapCtx, relocateFrom } from './patches.mjs';
import { castPack } from './scene.mjs';

const lastUserIndex = chat => { for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user && !chat[i]?.is_system) return i; return -1; };

function stamp(msg, loc, move) {
    msg.extra = msg.extra ?? {};
    // Player-only stays a string stamp. An actor already placed on this message is kept.
    msg.extra[LOC_KEY] = placeStamp(msg.extra[LOC_KEY], PLAYER, loc.address);
    if (move) msg.extra[MOVE_KEY] = move;
}

/** Move through an exit of the current location. Returns {ok, to, move} or {ok:false, error, valid}. */
async function engineMove(direction) {
    const from = await currentLocation();
    const exit = from.exits.find(e => e.direction.toLowerCase() === String(direction).trim().toLowerCase());
    if (exit && isStuck(exit)) return { ok: false, error: `The ${exit.direction} ${stuckWhy(exit)}.`, valid: from.exits.filter(e => !isStuck(e)).map(e => e.direction) };
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from: from.address, direction: String(direction).trim(), ...mapCtx() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return { ok: false, error: d.error ?? `Move failed (${r.status})`, valid: d.valid_directions ?? from.exits.map(e => e.direction) };
    }
    primeCache(r.body);
    return { ok: true, to: r.body, move: { seconds: r.body.travel_seconds ?? 0, direction: exit?.direction ?? direction, prev_name: from.name, from: from.address, from_name: displayName(from), to: r.body.address, to_name: displayName(r.body), ...(r.body.traversal ? { traversal: [r.body.traversal] } : {}) } };
}

/** Normalize the model's answer and accept it only if it is exactly one of the options. */
/**
 * Strip quotes, markdown and trailing punctuation from a model answer, but keep a closing ")" that belongs to the
 * answer: option labels look like "Common Room (The Drowned Rat)" and used to lose their ")" here, so a correct
 * answer naming a room "Name (Building)" never matched.
 */
export function trimAnswer(answer) {
    let a = String(answer ?? '').trim().replace(/^[\s"'`*_.:\-\[]+|[\s"'`*_.:!?\]]+$/g, '');
    while (a.startsWith('(') && a.endsWith(')')) a = a.slice(1, -1).trim(); // "(north)"
    if (a.startsWith('(') && !a.includes(')')) a = a.slice(1).trim();
    if (a.endsWith(')') && !a.includes('(')) a = a.slice(0, -1).trim();
    return a;
}
export function parseChoice(answer, options) {
    const a = trimAnswer(answer).toLowerCase();
    return options.find(o => o.toLowerCase() === a) ?? null;
}

// ---- Pick-one questions (dev standard, see README "Prompt rules"): options are short text keys, never numbers.
/** Lowercase, punctuation/underscores/dashes to single spaces. */
export const normKey = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** A short unique key for a label ("Common Room (The Drowned Rat)" -> "common_room_the_drowned"). `taken` is a Set. */
export function keyFor(label, taken = new Set()) {
    const base = normKey(label).split(' ').slice(0, 4).join('_') || 'option';
    let k = base;
    for (let i = 2; taken.has(k); i++) k = `${base}_${i}`;
    taken.add(k);
    return k;
}
/**
 * Match a model answer to one key, ignoring case, punctuation and extra words: an exact match first, else the one
 * key that appears as whole words in the answer (the longest wins; a tie is no match). Returns the key or null.
 */
export function matchKey(answer, keys) {
    const a = normKey(cleanAnswer(answer));
    if (!a) return null;
    const nk = keys.map(normKey), exact = nk.indexOf(a);
    if (exact >= 0) return keys[exact];
    const hits = keys.filter((k, i) => nk[i] && ` ${a} `.includes(` ${nk[i]} `));
    if (!hits.length) return null;
    const len = Math.max(...hits.map(k => normKey(k).length)), best = [...new Set(hits.filter(k => normKey(k).length === len))];
    return best.length === 1 ? best[0] : null;
}
/** "- key: meaning" lines for a pick-one prompt. */
export const optionLines = opts => opts.map(o => `- ${o.key}: ${o.label}`).join('\n');
/** askValid validator: the chosen option object, or null. */
export const pickKey = opts => a => { const k = matchKey(a, opts.map(o => o.key)); return k == null ? null : opts.find(o => o.key === k); };

// ---- Discovered places and route-finding (read-only map; visited set derived from this chat's messages).

// ---- Obscured/hidden doors. The server gives each flagged exit and its return exit the same opaque `door` id.
// Walking through either side reveals both. Which doors were walked through is derived from this chat's move
// stamps (room left + direction taken), so it rolls back with swipes/deletes. Destinations behind passed doors
// come from POST /doors and are merged into rooms by fetchLocationCached; nothing else ever sees them.
let revealedDoors = new Set();
const doorInfo = new Map(); // "address|direction" -> revealed exit data
/** [{from, direction}] for every step this chat's messages record. */
export function stepsTaken(chat = ctx().chat ?? []) {
    const out = [];
    for (const m of chat) {
        const mv = m?.extra?.[MOVE_KEY];
        if (!mv?.from) continue;
        if (mv.steps?.length) mv.steps.forEach((d, i) => out.push({ from: i ? mv.via?.[i - 1] : mv.from, direction: d }));
        else if (mv.direction) out.push({ from: mv.from, direction: mv.direction });
    }
    return out.filter(x => x.from && x.direction);
}
/** Recompute the passed doors from the chat (fetching any missing reveal data in one request). */
export async function syncDoors() {
    const steps = stepsTaken();
    await warmRooms(steps.map(s => s.from));
    const doors = new Set(worldSeed()?.doors ?? []);
    for (const st of steps) {
        const e = (await fetchRaw(st.from))?.exits?.find(x => x.direction.toLowerCase() === String(st.direction).toLowerCase());
        if (!e) console.warn(`[WorldScrawl] stamped step ${st.direction} from ${st.from} not in this world; skipped`);
        if (e?.door) doors.add(e.door);
    }
    const missing = [...doors].filter(d => !doorFetched.has(d));
    if (missing.length) {
        try {
            const r = await api('/doors', { method: 'POST', body: JSON.stringify({ doors: missing }) });
            if (r.ok) { for (const x of r.body.exits ?? []) doorInfo.set(`${x.from}|${x.direction.toLowerCase()}`, x); missing.forEach(d => doorFetched.add(d)); }
        } catch {}
    }
    revealedDoors = doors;
    return doors;
}
const doorFetched = new Set();
/** A room as the party knows it: flagged exits whose door was passed carry their destination (revealed: true). */
export function applyReveals(loc) {
    if (!loc?.exits?.some(e => e.door && (e.hidden || e.obscured))) return loc;
    return { ...loc, exits: loc.exits.map(e => {
        const info = (e.hidden || e.obscured) && revealedDoors.has(e.door) ? doorInfo.get(`${loc.address}|${e.direction.toLowerCase()}`) : null;
        return info ? { ...e, ...info, revealed: true } : e;
    }) };
}
/** Every displayed/prompted exit goes through here: "north (Village Square)", or just "north" if not revealed. */
/** "Stable" vs "stable", "Kitchens" vs "kitchen", "The Forge" vs "forge": the same word, so show it once. */
/** Plural-tolerant word match: equal, or one is the other + "s" / + "es" (grate/grates, box/boxes, kitchen/kitchens). */
export const sameWord = (a, b) => { a = String(a ?? '').toLowerCase(); b = String(b ?? '').toLowerCase(); return a === b || a === b + 's' || a === b + 'es' || b === a + 's' || b === a + 'es'; };
const labelWords = x => String(x ?? '').toLowerCase().trim().replace(/^the\s+/, '').split(/\s+/).filter(Boolean);
/** Same label word for word, ignoring case, a leading "the" and plurals ("Kitchens" vs "kitchen", "Stable" vs "stable"). */
export const sameLabel = (a, b) => { const x = labelWords(a), y = labelWords(b); return x.length === y.length && x.every((w, i) => sameWord(w, y[i])); };
export const sameAsDirection = exit => sameLabel(exit.direction, destLabel(exit));
export const exitLabel = (exit, fmt = n => ` (${n})`, withSub = false) =>
    exit.direction + (revealsDestination(exit) && (withSub || !sameAsDirection(exit)) ? fmt(withSub && exit.to_subregion?.name ? `${exit.to_name}, ${exit.to_subregion.name}` : destLabel(exit)) : '');
/** The server's label for where an exit leads, seen from this room: "Courtyard", "The Gilded Goose", "The Drowned Rat, Stable". */
export const destLabel = exit => exit.to_label ?? exit.to_name;
/** Destination labels shown more than once among these exits (those get the full "Room (Building)" name). */
export function collidingNames(exits) {
    const seen = new Map();
    for (const e of exits ?? []) if (revealsDestination(e)) seen.set(destLabel(e), (seen.get(destLabel(e)) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}
export const exitLabels = (exits, fmt) => { const c = collidingNames(exits); return (exits ?? []).map(e => exitLabel(e, fmt, c.has(destLabel(e)))); };
/** "Name (Subregion)", or just the name when the subregion has the same name. */
export const placeLabel = (name, sub) => (sub && sub !== name ? `${name} (${sub})` : name);
/** Unambiguous name for the model: "Common Room (The Drowned Rat)". */
export const displayName = loc => loc.display_name ?? placeLabel(loc.name, loc.subregion?.name);

/** Places stood in during this chat: the start plus every location (and route step) saved on its messages, plus Reveal map's places while it is on. */
async function stoodInAddresses() {
    await syncDoors();
    const saved = [...new Set([...chatAddresses(), ...await revealedAddresses()])];
    await warmRooms([...saved, ...(worldSeed()?.stood ?? []), ...(worldSeed()?.seen ?? [])]); // anything not remembered yet (e.g. after a reload) comes in one batch request
    const set = new Set();
    const start = await fetchLocationCached(null);
    if (start) set.add(start.address);
    for (const a of saved) set.add(a);
    for (const a0 of worldSeed()?.stood ?? []) { const a = relocateFrom(a0, 0, ctx().chat ?? []); if ((await fetchRaw(a))) set.add(a); } // seeded knowledge + stamps
    return set;
}
/** Every address saved on this chat's messages (locations and route steps), in order. */
function chatAddresses() {
    // Through any later move/merge redirects, so places stood in before a move stay known at their new address.
    const out = [], chat = ctx().chat ?? [];
    chat.forEach((m, i) => {
        const add = a => out.push(relocateFrom(a, i, chat));
        const loc = playerAddress(m?.extra?.[LOC_KEY]);
        if (loc) add(loc);
        for (const a of m?.extra?.[MOVE_KEY]?.via ?? []) add(a);
        if (m?.extra?.worldscrawl_notice_loc) add(m.extra.worldscrawl_notice_loc);
    });
    return [...new Set(out)];
}

/** Where the party was just before arriving at `current` (from saved message locations), or null. */
export function previousAddress(current, chat = ctx().chat ?? []) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i]?.extra;
        const mv = m?.[MOVE_KEY];
        if (mv && mv.to === current) { const via = mv.via ?? []; return via.length > 1 ? via[via.length - 2] : mv.from; }
        const loc = playerAddress(m?.[LOC_KEY]);
        if (loc && loc !== current) return loc;
    }
    return null;
}

/**
 * Discovered = stood in, plus any destination seen listed (and revealed) as an exit from a place stood in.
 * Map address -> {address, name, display_name, subregion, region}. Places only seen as exits are described by
 * the exit itself (the server puts the destination's name/area/region on every revealed exit), so neighbouring
 * rooms are never fetched just to name them.
 */
async function discoveredPlaces() {
    const stood = await stoodInAddresses();
    const known = new Map();
    for (const a of stood) {
        const l = await fetchLocationCached(a);
        if (l) known.set(a, { address: a, name: l.name, display_name: displayName(l), subregion: l.subregion, region: l.region });
    }
    for (const a of stood) for (const e of (await fetchLocationCached(a))?.exits ?? []) {
        if (revealsDestination(e) && e.to && !known.has(e.to)) known.set(e.to, { address: e.to, name: e.to_name, display_name: e.to_display_name ?? placeLabel(e.to_name, e.to_subregion?.name), subregion: e.to_subregion, region: e.to_region });
    }
    for (const a of stood) for (const v of (await fetchLocationCached(a))?.views ?? []) {
        if (!known.has(v.address)) { const l = await fetchRaw(v.address) ?? await newRoom(v.address); if (l) known.set(v.address, { address: v.address, name: l.name, display_name: displayName(l), subregion: l.subregion, region: l.region }); }
    }
    for (const a0 of worldSeed()?.seen ?? []) {
        const a = relocateFrom(a0, 0, ctx().chat ?? []);
        const l = known.has(a) ? null : await fetchRaw(a);
        if (l) known.set(a, { address: a, name: l.name, display_name: displayName(l), subregion: l.subregion, region: l.region });
    }
    return known;
}

/**
 * Building/area and region names as destinations: each known subregion (and region) maps to its entrance
 * room (set in the region file; default first room / region start), if that room is itself known.
 * [{address, name, label, area: true}]
 */
async function areaTargets(known) {
    const out = [], seen = new Set();
    for (const [a, l] of known) {
        for (const [area, prefix] of [[l?.subregion, l?.subregion && `${a.split(':')[0]}:${l.subregion.id}/`], [l?.region, null]]) {
            if (!area?.entrance || !known.has(area.entrance)) continue;
            const key = `${area.name}|${area.entrance}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // prefix: travelling to a building may end in any room of it the party has stood in, if that is nearer
            out.push({ address: area.entrance, name: area.name, label: area.name, area: true, ...(prefix ? { prefix } : {}) });
        }
    }
    return out;
}

/** Add area names unless a room already has that label for the same room; rename clashing labels. */
function mergeAreas(list, areas) {
    for (const ar of areas) {
        const same = list.find(x => x.label.toLowerCase() === ar.label.toLowerCase());
        if (same && same.address === ar.address) continue;
        list.push(same ? { ...ar, label: `${ar.label} (area)` } : ar);
    }
    return list;
}

/** Discovered places that are not here and not one exit away, plus area names: [{address, name, label}]. */
async function discoveredTargets(loc) {
    const adjacent = new Set(loc.exits.filter(revealsDestination).map(e => e.to));
    const out = [];
    const known = await discoveredPlaces();
    for (const [a, l] of known) {
        if (a === loc.address || adjacent.has(a)) continue;
        out.push({ address: a, name: l.name, label: l.display_name });
    }
    mergeAreas(out, (await areaTargets(known)).filter(ar => ar.address !== loc.address && !adjacent.has(ar.address)));
    const used = new Map(); // keep labels unique
    for (const p of out) { const n = (used.get(p.label) ?? 0) + 1; used.set(p.label, n); if (n > 1) p.label = `${p.label} #${n}`; }
    return out;
}

/**
 * Shortest path (BFS over exits, within the current region) from `from` to `target`: [{direction, to}] or null.
 * Intermediate steps only pass through `stoodIn` places (when given); the target may be any known place.
 * Hidden/obscured exits (same revealsDestination check) are never used.
 */
export async function findPath(from, target, getLoc = fetchLocationCached, stoodIn = null) {
    const region = from.split(':')[0];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === target) break;
        const loc = await getLoc(cur);
        for (const e of loc?.exits ?? []) {
            if (prev.has(e.to) || !revealsDestination(e) || isStuck(e, new Map())) continue;
            if (e.to !== target && (e.to.split(':')[0] !== region || (stoodIn && !stoodIn.has(e.to)))) continue;
            prev.set(e.to, { from: cur, direction: e.direction });
            queue.push(e.to);
        }
    }
    if (!prev.has(target)) return null;
    const steps = [];
    for (let a = target; prev.get(a); a = prev.get(a).from) steps.unshift({ direction: prev.get(a).direction, to: a });
    return steps;
}

/** Walk a route step by step through POST /move. Returns {ok, to, move} like engineMove. */
async function engineTravel(target, prefix = null) {
    const from = await currentLocation();
    const stood = await stoodInAddresses();
    let steps = await findPath(from.address, target, fetchLocationCached, stood);
    if (prefix) { // building by name: the nearest of its entrance and the rooms of it already stood in
        for (const alt of stood) {
            if (!alt.startsWith(prefix) || alt === target || alt === from.address) continue;
            const p = await findPath(from.address, alt, fetchLocationCached, stood);
            if (p?.length && (!steps?.length || p.length < steps.length)) { steps = p; target = alt; }
        }
    }
    if (!steps?.length) {
        console.warn(`[WorldScrawl] no route ${from.address} -> ${target}; stood in: ${[...(await stoodInAddresses())].join(', ')}`);
        return { ok: false, error: 'No known route.', valid: from.exits.map(e => e.direction) };
    }
    // One request for the whole trip. The server walks it step by step and may stop early (blocked step now,
    // encounters later): the party goes where the server says it ended up, not where we asked to go.
    const r = await api('/travel', { method: 'POST', body: JSON.stringify({ from: from.address, steps: steps.map(st => st.direction), ...mapCtx() }) });
    if (!r.ok || !r.body?.path?.length) return { ok: false, error: r.body?.error ?? 'Route blocked.', valid: from.exits.map(e => e.direction) };
    r.body.path.forEach(primeCache);
    const at = r.body.location;
    const names = [displayName(from), ...r.body.path.map(displayName)];
    const via = r.body.path.map(l => l.address);
    if (r.body.stopped) console.warn(`[WorldScrawl] travel stopped at ${at.address} after ${r.body.steps_completed}/${steps.length} steps (${r.body.reason})`);
    const single = r.body.path.length === 1 ? steps[0].direction : null;
    const lastDir = steps[r.body.path.length - 1]?.direction ?? null;
    const prevName = (r.body.path.length > 1 ? r.body.path[r.body.path.length - 2] : from).name;
    return { ok: true, to: at, move: { seconds: r.body.travel_seconds ?? 0, direction: single, from: from.address, from_name: displayName(from), to: at.address, to_name: displayName(at), path: names, via, steps: steps.slice(0, r.body.path.length).map(st => st.direction), last_direction: lastDir, prev_name: prevName,
        ...((r.body.step_traversal ?? []).some(Boolean) ? { traversal: r.body.step_traversal.filter(Boolean) } : {}),
        ...(r.body.stopped ? { stopped: r.body.reason ?? 'stopped' } : {}) } };
}

/**
 * Everything the party could head for from here: exits (by direction, label = destination) and known
 * non-adjacent places. [{label, name, direction?, address}]
 */
async function travelCandidates(here) {
    const coll = collidingNames(here.exits);
    const exits = here.exits.filter(revealsDestination).map(e => ({ label: placeLabel(e.to_name, e.to_subregion?.name), name: e.to_name, direction: e.direction, address: e.to }));
    // area names whose entrance is one exit away travel through that exit
    const near = (await areaTargets(await discoveredPlaces())).map(ar => ({ ...ar, direction: exits.find(x => x.address === ar.address)?.direction })).filter(ar => ar.direction);
    return mergeAreas([...exits, ...(await discoveredTargets(here)).map(p => ({ ...p }))], near);
}

/** Candidates matching a typed name: exact label first, else every candidate with that plain name. */
export function matchCandidates(text, cands) {
    const t = String(text ?? '').trim().toLowerCase();
    const byLabel = cands.filter(c => c.label.toLowerCase() === t);
    return byLabel.length ? byLabel : cands.filter(c => c.name.toLowerCase() === t);
}

const GENERIC_WORDS = new Set(['the', 'a', 'an', 'of', 'room', 'rooms']);
const words = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).map(w => w.replace(/'s$/, '')).filter(Boolean);
const keyWords = x => { const w = words(x).filter(t => !GENERIC_WORDS.has(t)); return w.length ? w : words(x).filter(t => t !== 'the'); };

/**
 * Known places named in the player's text (used only after the model said elsewhere/unclear).
 * Case-insensitive, word-level: a key word of the name must appear ("upstairs" matches "Upstairs Rooms";
 * a leading "the" and generic words like "room" are ignored). The most specific matches win, so
 * "common room of the drowned rat" picks the one whose label also matches "drowned rat".
 */
export function namedInText(text, cands) {
    const said = new Set(words(text));
    const scored = cands.map(x => {
        const nameKeys = keyWords(x.name);
        const hit = nameKeys.filter(w => said.has(w)).length;
        if (!hit) return null;
        const extra = keyWords(x.label).filter(w => !nameKeys.includes(w) && said.has(w)).length;
        return { x, score: hit * 10 + extra };
    }).filter(Boolean);
    const best = Math.max(0, ...scored.map(s => s.score));
    const byAddr = new Map(scored.filter(s => s.score === best).map(s => [s.x.address, s.x]));
    return [...byAddr.values()];
}

/** The building/area and region the party is in, as name-only candidates (for "You're already in X."). */
const hereAreas = loc => [loc.subregion, loc.region].filter(a => a?.name).map(a => ({ name: a.name, label: a.name, address: `@here:${a.name}`, here: true }));
const sameName = (a, b) => keyWords(a).join(' ') === keyWords(b).join(' ');
export const alreadyText = (loc, name) => `You're already in ${name}. ${exitsText(loc)}`;

/**
 * Ways out of the current building (or region) when this room has none: rooms of it the party has stood in
 * that have an exit leaving it; returns the outside rooms reached at the shortest route length (ties = several).
 */
async function nearestWaysOut(loc, isRegion) {
    const regionOf = a => a.split(':')[0];
    const prefix = isRegion ? `${regionOf(loc.address)}:` : `${regionOf(loc.address)}:${loc.subregion?.id}/`;
    const stood = await stoodInAddresses();
    const outside = new Map();
    for (const a of stood) {
        if (!a.startsWith(prefix)) continue;
        for (const e of (await fetchLocationCached(a))?.exits ?? []) {
            if (revealsDestination(e) && !e.to.startsWith(prefix)) outside.set(e.to, e);
        }
    }
    let best = [], bestLen = Infinity;
    for (const [to, e] of outside) {
        const steps = await findPath(loc.address, to, fetchLocationCached, stood);
        if (!steps?.length) continue;
        const item = { label: placeLabel(e.to_name, e.to_subregion?.name), name: e.to_name, address: to };
        if (steps.length < bestLen) { best = [item]; bestLen = steps.length; } else if (steps.length === bestLen) best.push(item);
    }
    return best;
}

/** /ws-go <direction | place name>: an exit direction, else a known place; several matches ask which one. */
/**
 * Who moves, as shown in the auto-sent move message and the notes to the model ("Knarfy goes north.").
 * Macros ({{user}}, {{char}}, ...) are resolved here, so no raw macro ever reaches a message or prompt.
 */
export function whoMoves() {
    const c = ctx();
    const raw = (settings().whoMoves ?? '').trim() || DEFAULTS.whoMoves;
    let out = raw;
    try { if (typeof c.substituteParams === 'function') out = c.substituteParams(raw); } catch (e) { console.warn('[WorldScrawl] substituteParams failed', e); }
    out = String(out ?? '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();
    return out || 'You';
}
/** The party is not stored. It is the player, then whoever is following them. */
export function partyMembers() {
    let extra = [];
    try {
        const chat = ctx().chat ?? [];
        if (chat.length) extra = followersAt(chat, chat.length - 1, castPack()?.npcs ?? []).filter(f => (f.who || PLAYER) === PLAYER);
    } catch { extra = []; }
    return [{ id: PLAYER, name: whoMoves() }, ...extra.map(f => ({ id: f.id, name: f.name }))];
}
/**
 * {{party}}: the names of the party. Today the group is only the player, so this is whoMoves()
 * and every prompt that says {{party}} reads the same as it did.
 */
export function partyText() {
    const names = partyMembers().map(a => a.name).filter(Boolean);
    if (names.length === 0) return 'You';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

async function goAction(arg) {
    const c = ctx();
    if (engineBusy) return 'WorldScrawl: already moving.';
    if (!arg) { toastr.warning('Usage: /ws-go <direction or known place>'); return ''; }
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    const here = await currentLocation();
    const exit = here.exits.find(e => e.direction.toLowerCase() === arg.toLowerCase());
    if (exit) return goTarget({ direction: exit.direction });
    const inside = hereAreas(here).find(a => sameName(a.name, arg));
    if (inside) { await addNotice({ loc: here, kind: 'already', name: inside.name }); renderAllExits(); return ''; }
    const found = matchCandidates(arg, await travelCandidates(here));
    if (found.length === 1) return goTarget(found[0]);
    if (found.length > 1) { await addNotice({ loc: here, kind: 'which', candidates: found }); renderAllExits(); return ''; }
    await addNotice({ loc: here }); renderAllExits(); return '';
}

/** Move to a target ({direction} or {address,label}), add a short user note, then let the model narrate. */
const DOOR_LIKE = /\b(door|doorway|gate|hatch|trapdoor|arch|archway|curtain|portal|passage|opening|crack|gap|hole|tunnel|grate|panel)s?$/i;
/**
 * The auto-sent move message. Hidden/obscured exits never reveal where they lead:
 * "Knarfy goes through the trapdoor." (door-like label) or "Knarfy takes the crawlspace exit.".
 */
/** Where an exit leads, for prose: "the Stable", "The Gilded Goose", "the Stable of The Drowned Rat", "Village Square". */
function exitDestPhrase(e) {
    const sub = e.to_subregion ?? {};
    const lbl = destLabel(e);
    if (sub.name && lbl.startsWith(`${sub.name}, `)) return `${withArticle(e.to_name)} of ${sub.name}`;
    if (sub.label_rooms) return e.to_name; // named public places: "Market Lane", not "the Market Lane"
    return lbl === e.to_name ? withArticle(e.to_name) : lbl;
}
export function moveNote(who, move, exit) {
    if (move.direction && exit && !revealsDestination(exit)) {
        const label = exit.direction;
        return DOOR_LIKE.test(label) ? `*${who} goes through the ${label}.*` : `*${who} takes the ${label} exit.*`;
    }
    if (move.direction && exit && !PLAIN_DIRECTIONS.has(move.direction.toLowerCase())) {
        // "gate", "stable", "inn": not a compass word, so say where it goes ("Knarfy goes to the Stable.")
        const dest = exitDestPhrase(exit);
        return DOOR_LIKE.test(move.direction) && !sameAsDirection(exit) ? `*${who} goes through the ${move.direction} to ${dest}.*` : `*${who} goes to ${dest}.*`;
    }
    return move.direction ? `*${who} goes ${move.direction}.*` : `*${who} heads to ${move.to_name}.*`;
}

/** The narrator's turn after an engine line. Not /trigger: ST treats that as an empty user send and, with
 *  "Replace empty message" set in the preset, posts that text as an extra player message first. */
export async function narrate(c = ctx()) {
    await c.generate('normal', { automatic_trigger: true });
}

export const STAY = 'stay', ELSEWHERE = 'elsewhere', UNCLEAR = 'unclear', OPEN = 'new opening';
/** Second guard on the 'new opening' choice: the message must use a breaking-through word. */
export const BREAK_RE = /\b(?:smash|smashes|smashed|smashing|break|breaks|breaking|broke|burst|bursts|bursting|bash|bashes|bashed|bashing|blast|blasts|blasted|blasting|shatter|shatters|shattered|shattering|breach|breaches|breached|breaching|dig|digs|dug|digging|carve|carves|carved|carving|(?:hack|hacks|hacked|hacking|cut|cuts|cutting|punch|punches|punched|punching) through|(?:kick|kicks|kicked|kicking) (?:in|down|through)|(?:knock|knocks|knocked|knocking) (?:down|through)|(?:tear|tears|tore|tearing) (?:down|through)|(?:make|makes|made|making|open|opens|opened|opening) a hole)\b/i;

/** Strip reasoning blocks, keep the last non-empty line, then exact-match against the options. */
export function cleanAnswer(answer) {
    const a = String(answer ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, '').replace(/<\/?(think|thinking|reasoning)>/gi, '');
    const lines = a.split('\n').map(l => l.trim()).filter(Boolean);
    return (lines[lines.length - 1] ?? '').replace(/^(answer|option|choice)\s*:\s*/i, '');
}
export const parseIntentAnswer = (answer, options) => parseChoice(cleanAnswer(answer), [...options, STAY, ELSEWHERE, UNCLEAR]);
export const parseYesNo = answer => parseChoice(cleanAnswer(answer), ['yes', 'no']);

export { chatAddresses, discoveredPlaces, discoveredTargets, doorFetched, doorInfo, engineMove, engineTravel, goAction, hereAreas, keyWords, lastUserIndex, nearestWaysOut, revealedDoors, sameName, stamp, stoodInAddresses, travelCandidates, words };
