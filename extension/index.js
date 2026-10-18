// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// the party's location; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// The party's location is stored on chat messages (message.extra.worldscrawl_location) so that
// deleting or swiping messages rolls the location back with them.
const MODULE = 'worldscrawl';
const LOC_KEY = 'worldscrawl_location';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: 'http://127.0.0.1:5100', nudge: DEFAULT_NUDGE, showExits: true, moveMode: 'typed', whoMoves: '{{user}}' };
const MODES = ['commands', 'typed', 'tools'];
const MOVE_KEY = 'worldscrawl_move'; // {direction, from, from_name, to, to_name} on the message that moved
const FACTS_KEY = 'worldscrawl_facts';
const TOOL_NAMES = ['ws_look', 'ws_move'];
const NUDGE_KEY = 'worldscrawl_nudge';

const ctx = () => SillyTavern.getContext();
const toolsOn = () => settings().moveMode === 'tools';
let pendingLocation = null;

export function settings() {
    const all = ctx().extensionSettings;
    const saved = all[MODULE] ?? {};
    if (!MODES.includes(saved.moveMode)) { // migrate the old v0.2 checkboxes
        saved.moveMode = saved.useTools ? 'tools' : saved.parseIntent === false ? 'commands' : 'typed';
    }
    delete saved.useTools; delete saved.parseIntent;
    all[MODULE] = Object.assign({}, DEFAULTS, saved);
    return all[MODULE];
}

const baseUrl = () => String(settings().serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, '');

let mapVersion = null;
/** Every server reply carries the map version; when it changes (map files edited, server restarted) drop remembered rooms. */
export function noteMapVersion(v) {
    if (!v) return;
    if (mapVersion && v !== mapVersion) { exitsCache.clear(); console.log(`[WorldScrawl] map changed (${mapVersion} -> ${v}); cleared remembered rooms`); }
    mapVersion = v;
}
export const cacheInfo = () => ({ size: exitsCache.size, mapVersion });

async function api(path, options = {}) {
    let res;
    try {
        // JSON content type only when sending a body: on a GET it would force a CORS preflight (an extra OPTIONS request).
        const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) };
        res = await fetch(baseUrl() + path, { ...options, headers });
    } catch (e) {
        throw new Error(`WorldScrawl server not reachable at ${baseUrl()} (${e.message}). Is it running?`);
    }
    noteMapVersion(res.headers.get('X-WorldScrawl-Map-Version'));
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

/** Latest location stored on a message, or null if this chat has none yet. */
export function getStoredLocation() {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const loc = chat[i]?.extra?.[LOC_KEY];
        if (loc) return loc;
    }
    return null;
}

/** Current location, from the in-memory cache (one shared request per address; /start fetched once). */
async function currentLocation() {
    const stored = getStoredLocation();
    if (stored) {
        const loc = await fetchLocationCached(stored);
        if (loc) return loc;
    }
    const start = await fetchLocationCached(null);
    if (!start) throw new Error(`WorldScrawl server not reachable at ${baseUrl()}, or /start failed. Is it running?`);
    return start;
}

/** Every chat gets a location from turn one: stamp the start onto the greeting (message 0) if nothing is saved. */
async function ensureStartStamp() {
    const c = ctx();
    const first = c.chat?.[0];
    if (!first || getStoredLocation()) return;
    const start = await fetchLocationCached(null);
    if (!start || c.chat?.[0] !== first || getStoredLocation()) return;
    first.extra = first.extra ?? {};
    first.extra[LOC_KEY] = start.address;
    // keep it on the greeting's swipes too, so swiping the greeting doesn't drop it
    for (const sw of first.swipe_info ?? []) { if (sw) { sw.extra = sw.extra ?? {}; sw.extra[LOC_KEY] = start.address; } }
    await c.saveChat();
}

function describe(loc) {
    return JSON.stringify({
        location: loc.name,
        address: loc.address,
        region: loc.region?.name,
        description: loc.description,
        exits: loc.exits.map(e => ({ direction: e.direction, ...(revealsDestination(e) ? { leads_to: e.to_name } : {}), ...(e.description ? { description: e.description } : {}) })),
    });
}

async function lookAction() {
    const loc = await currentLocation();
    if (!getStoredLocation()) pendingLocation = loc.address; // first look in a chat fixes the start location
    return describe(loc);
}

async function moveAction({ direction } = {}) {
    if (!direction) return JSON.stringify({ error: 'direction is required' });
    const from = (await currentLocation()).address;
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from, direction }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return JSON.stringify({ error: d.error ?? `Move failed (${r.status})`, valid_directions: d.valid_directions ?? [] });
    }
    pendingLocation = r.body.address;
    primeCache(r.body);
    return describe(r.body);
}

function stampLocation() {
    if (!pendingLocation) return;
    const chat = ctx().chat;
    const msg = chat?.[chat.length - 1];
    if (msg) {
        msg.extra = msg.extra ?? {};
        msg.extra[LOC_KEY] = pendingLocation;
    }
    pendingLocation = null;
}

function applyTools() {
    const c = ctx();
    if (!toolsOn()) { TOOL_NAMES.forEach(n => { try { c.unregisterFunctionTool(n); } catch {} }); return; }
    registerTools();
}

function registerTools() {
    const { registerFunctionTool } = ctx();
    registerFunctionTool({
        name: 'ws_look',
        displayName: 'WorldScrawl: Look',
        description: 'Get the characters\' current location in the world map: its name, description and the exits leading out of it. Use this before describing where the characters are or where they can go.',
        parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {}, required: [] },
        action: lookAction,
        formatMessage: () => 'Looking around...',
    });
    registerFunctionTool({
        name: 'ws_move',
        displayName: 'WorldScrawl: Move',
        description: 'Move the characters through one of the current location\'s exits when the characters travel there. Returns the new location. If the direction is not valid, returns an error with the valid directions.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { direction: { type: 'string', description: 'The exit direction exactly as listed by ws_look, e.g. "north" or "out".' } },
            required: ['direction'],
        },
        action: moveAction,
        formatMessage: ({ direction } = {}) => `Moving ${direction ?? ''}...`,
    });
}

/** Short system note at depth 1 so the model actually uses the tools (they are ignored without it on many models). */
function applyNudge() {
    const text = toolsOn() ? String(settings().nudge ?? '').trim() : '';
    ctx().setExtensionPrompt(NUDGE_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

// ---- Engine-driven movement. The engine moves the party; the model never touches the map.
let engineBusy = false;
const lastUserIndex = chat => { for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user && !chat[i]?.is_system) return i; return -1; };

function stamp(msg, loc, move) {
    msg.extra = msg.extra ?? {};
    msg.extra[LOC_KEY] = loc.address;
    if (move) msg.extra[MOVE_KEY] = move;
}

/** Move through an exit of the current location. Returns {ok, to, move} or {ok:false, error, valid}. */
async function engineMove(direction) {
    const from = await currentLocation();
    const exit = from.exits.find(e => e.direction.toLowerCase() === String(direction).trim().toLowerCase());
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from: from.address, direction: String(direction).trim() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return { ok: false, error: d.error ?? `Move failed (${r.status})`, valid: d.valid_directions ?? from.exits.map(e => e.direction) };
    }
    primeCache(r.body);
    return { ok: true, to: r.body, move: { direction: exit?.direction ?? direction, from: from.address, from_name: displayName(from), to: r.body.address, to_name: displayName(r.body) } };
}

/** Normalize the model's answer and accept it only if it is exactly one of the options. */
export function parseChoice(answer, options) {
    const a = String(answer ?? '').trim().toLowerCase().replace(/^[\s"'`*_.:\-\[(]+|[\s"'`*_.:!?\])]+$/g, '');
    return options.find(o => o.toLowerCase() === a) ?? null;
}

// ---- Discovered places and route-finding (read-only map; visited set derived from this chat's messages).
/**
 * The one place that decides whether an exit reveals where it leads. Later a hidden/obscured exit
 * (e.g. exit.hidden or exit.obscured in the region file) can return false here.
 */
export const revealsDestination = exit => !(exit?.hidden || exit?.obscured);
/** Every displayed/prompted exit goes through here: "north (Village Square)", or just "north" if not revealed. */
export const exitLabel = (exit, fmt = n => ` (${n})`, withSub = false) =>
    exit.direction + (revealsDestination(exit) ? fmt(withSub && exit.to_subregion?.name ? `${exit.to_name}, ${exit.to_subregion.name}` : exit.to_name) : '');
/** Destination names shown more than once among these exits (those get their subregion added). */
export function collidingNames(exits) {
    const seen = new Map();
    for (const e of exits ?? []) if (revealsDestination(e)) seen.set(e.to_name, (seen.get(e.to_name) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}
export const exitLabels = (exits, fmt) => { const c = collidingNames(exits); return (exits ?? []).map(e => exitLabel(e, fmt, c.has(e.to_name))); };
/** "Name (Subregion)", or just the name when the subregion has the same name. */
export const placeLabel = (name, sub) => (sub && sub !== name ? `${name} (${sub})` : name);
/** Unambiguous name for the model: "Common Room (The Drowned Rat)". */
export const displayName = loc => loc.display_name ?? placeLabel(loc.name, loc.subregion?.name);

/** Places stood in during this chat: the start plus every location (and route step) saved on its messages. */
async function stoodInAddresses() {
    const saved = chatAddresses();
    await warmRooms(saved); // anything not remembered yet (e.g. after a reload) comes in one batch request
    const set = new Set();
    const start = await fetchLocationCached(null);
    if (start) set.add(start.address);
    for (const a of saved) set.add(a);
    return set;
}
/** Every address saved on this chat's messages (locations and route steps), in order. */
function chatAddresses() {
    const out = [];
    for (const m of ctx().chat ?? []) {
        const loc = m?.extra?.[LOC_KEY];
        if (loc) out.push(loc);
        for (const a of m?.extra?.[MOVE_KEY]?.via ?? []) out.push(a);
        if (m?.extra?.worldscrawl_notice_loc) out.push(m.extra.worldscrawl_notice_loc);
    }
    return [...new Set(out)];
}

/** Where the party was just before arriving at `current` (from saved message locations), or null. */
export function previousAddress(current, chat = ctx().chat ?? []) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i]?.extra;
        const mv = m?.[MOVE_KEY];
        if (mv && mv.to === current) { const via = mv.via ?? []; return via.length > 1 ? via[via.length - 2] : mv.from; }
        if (m?.[LOC_KEY] && m[LOC_KEY] !== current) return m[LOC_KEY];
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
            if (prev.has(e.to) || !revealsDestination(e)) continue;
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
    const r = await api('/travel', { method: 'POST', body: JSON.stringify({ from: from.address, steps: steps.map(st => st.direction) }) });
    if (!r.ok || !r.body?.path?.length) return { ok: false, error: r.body?.error ?? 'Route blocked.', valid: from.exits.map(e => e.direction) };
    r.body.path.forEach(primeCache);
    const at = r.body.location;
    const names = [displayName(from), ...r.body.path.map(displayName)];
    const via = r.body.path.map(l => l.address);
    if (r.body.stopped) console.warn(`[WorldScrawl] travel stopped at ${at.address} after ${r.body.steps_completed}/${steps.length} steps (${r.body.reason})`);
    const single = r.body.path.length === 1 ? steps[0].direction : null;
    return { ok: true, to: at, move: { direction: single, from: from.address, from_name: displayName(from), to: at.address, to_name: displayName(at), path: names, via,
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
async function goTarget(t) {
    const c = ctx();
    if (engineBusy) return 'WorldScrawl: already moving.';
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    engineBusy = true;
    try {
        const here = await currentLocation();
        const exit = t.direction ? here.exits.find(e => e.direction.toLowerCase() === t.direction.toLowerCase())
            : t.prefix ? null : here.exits.find(e => e.to === t.address && revealsDestination(e));
        let res;
        if (exit) res = await engineMove(exit.direction);
        else if (t.direction) res = await engineMove(t.direction);
        else {
            res = await engineTravel(t.address, t.prefix ?? null);
            if (!res.ok) { await addNotice({ loc: here, noRoute: t.label ?? t.name }); renderAllExits(); return ''; }
        }
        if (!res.ok) { toastr.warning(`${res.error} Exits: ${res.valid.join(', ') || 'none'}`); return res.error; }
        const who = whoMoves();
        const note = res.move.direction ? `*${who} goes ${res.move.direction}.*` : `*${who} heads to ${res.move.to_name}.*`;
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stamp(msg, res.to, res.move);
        msg.extra.worldscrawl_engine = true; // no intent question for this message
        await c.saveChat();
        renderAllExits();
        await c.executeSlashCommandsWithOptions('/trigger await=true');
        return '';
    } catch (e) {
        toastr.error(e.message); return e.message;
    } finally {
        engineBusy = false;
    }
}

export const STAY = 'stay', ELSEWHERE = 'elsewhere', UNCLEAR = 'unclear';

/** Strip reasoning blocks, keep the last non-empty line, then exact-match against the options. */
export function cleanAnswer(answer) {
    const a = String(answer ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, '').replace(/<\/?(think|thinking|reasoning)>/gi, '');
    const lines = a.split('\n').map(l => l.trim()).filter(Boolean);
    return (lines[lines.length - 1] ?? '').replace(/^(answer|option|choice)\s*:\s*/i, '');
}
export const parseIntentAnswer = (answer, options) => parseChoice(cleanAnswer(answer), [...options, STAY, ELSEWHERE, UNCLEAR]);
export const parseYesNo = answer => parseChoice(cleanAnswer(answer), ['yes', 'no']);

const SYS = 'You classify player intent for a text adventure game. Reply with exactly one option from the list and nothing else.';

/**
 * Ask the model one multiple-choice question about the player's message.
 * Returns {kind:'move'|'stay'|'elsewhere', loc}. An unreadable answer gets a yes/no follow-up
 * ("trying to travel?"): a clear yes is 'elsewhere', anything else is 'stay'.
 */
async function parseIntent(msg) {
    const c = ctx();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    const loc = await currentLocation();
    const dirs = loc.exits.map(e => e.direction);
    const places = await discoveredTargets(loc);
    const prev = previousAddress(loc.address);
    const options = [...dirs, ...places.map(p => p.label), STAY, ELSEWHERE, UNCLEAR];
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exitLines = exitLabels(loc.exits, n => n).map((lbl, i) => {
        const e = loc.exits[i];
        const nm = e.to_subregion?.name && e.to_subregion.name !== e.to_name ? `${e.to_name}, ${e.to_subregion.name}` : lbl.slice(e.direction.length);
        return `- ${e.direction}${revealsDestination(e) ? ` (to ${nm}${e.to === prev ? ', where you came from' : ''})` : ''}`;
    });
    const prompt = `${whoMoves()} is at ${displayName(loc)}. Its exits are:\n${exitLines.join('\n') || '- (none)'}\n\n`
        + `${said}\n\nAnswer with one option:\n`
        + dirs.map(d => `- ${d}: the player goes through the "${d}" exit right now\n`).join('')
        + places.map(p => `- ${p.label}: the player travels to ${p.label}, a place they know about\n`).join('')
        + `- ${STAY}: the player is not trying to travel anywhere\n`
        + `- ${ELSEWHERE}: the player wants to go to a place that is not listed above\n`
        + `- ${UNCLEAR}: the player wants to travel, but it is unclear which of the listed places they mean\n\n`
        + `Which option: ${options.join(', ')}? Reply with exactly one option from that list.`;
    const answer = await c.generateRaw({ prompt, systemPrompt: SYS, responseLength: 48 });
    const cands = await travelCandidates(loc);
    let choice = parseIntentAnswer(answer, [...dirs, ...places.map(p => p.label)]);
    const ans = cleanAnswer(answer).replace(/^[\s"'`*_.:\-\[(]+|[\s"'`*_.:!?\])]+$/g, '');
    const insideAns = !dirs.includes(choice) && hereAreas(loc).find(a => sameName(a.name, choice ?? ans));
    if (insideAns) return { kind: 'already', loc, name: insideAns.name };
    if (!choice) { // a bare name that matches known places (e.g. "Upstairs Rooms")
        const m = matchCandidates(cleanAnswer(answer).replace(/^[\s"'`*_.:\-\[(]+|[\s"'`*_.:!?\])]+$/g, ''), cands);
        if (m.length > 1) return { kind: 'which', loc, candidates: m };
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
    }
    if (!choice) {
        const yn = await c.generateRaw({ prompt: `${whoMoves()} is at ${loc.name}.\n${said}\n\nIs the player trying to travel to a different place? Answer yes or no.`, systemPrompt: 'Reply with exactly one word: yes or no.', responseLength: 48 });
        choice = parseYesNo(yn) === 'yes' ? ELSEWHERE : STAY;
        console.log(`[WorldScrawl] intent fallback: ${JSON.stringify(String(yn).slice(0, 80))} -> ${choice}`);
    }
    console.log(`[WorldScrawl] intent: ${JSON.stringify(String(answer).slice(0, 80))} -> ${choice}`);
    if (choice === STAY) return { kind: STAY, loc };
    if (choice === ELSEWHERE || choice === UNCLEAR) {
        const inside = namedInText(msg.mes, hereAreas(loc))[0];
        if (inside) {
            if (LEAVING_RE.test(msg.mes ?? '')) {
                // "I leave the Drowned Rat": the exits from this room that lead out of the named building/region
                const isRegion = sameName(inside.name, loc.region?.name ?? '') && !sameName(inside.name, loc.subregion?.name ?? '');
                const regionOf = a => a.split(':')[0];
                const outs = loc.exits.filter(e => revealsDestination(e) && (isRegion ? regionOf(e.to) !== regionOf(loc.address) : e.to_subregion?.id !== loc.subregion?.id));
                if (outs.length === 1) choice = outs[0].direction;
                else if (outs.length > 1) return { kind: 'which', loc, prefix: WAY_OUT_PREFIX, candidates: outs.map(e => ({ label: exitLabel(e), name: e.to_name, direction: e.direction, address: e.to })) };
                else { // no way out from this room: nearest way out through visited rooms (normal route rules)
                    const best = await nearestWaysOut(loc, isRegion);
                    if (best.length === 1) {
                        const res = await engineTravel(best[0].address);
                        if (!res.ok) return { kind: ELSEWHERE, loc };
                        stamp(msg, res.to, res.move);
                        return { kind: 'move', loc: res.to };
                    }
                    if (best.length > 1) return { kind: 'which', loc, prefix: WAY_OUT_PREFIX, candidates: best };
                    return { kind: ELSEWHERE, loc };
                }
            } else if (!namedInText(msg.mes, cands).length) return { kind: 'already', loc, name: inside.name };
        }
    }
    if (choice === ELSEWHERE) { // safety net: the player named a known place the model didn't pick
        const named = namedInText(msg.mes, cands);
        if (named.length > 1) return { kind: 'which', loc, candidates: named };
        if (named.length === 1) choice = named[0].direction ?? named[0].label;
        else return { kind: ELSEWHERE, loc };
    }
    if (choice === UNCLEAR) {
        const m = namedInText(msg.mes, cands);
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
        else return { kind: 'which', loc, candidates: m.length ? m : cands };
    }
    const place = places.find(p => p.label === choice) ?? (dirs.includes(choice) ? null : cands.find(x => x.label === choice && !x.direction));
    const nearArea = !dirs.includes(choice) && cands.find(x => x.label === choice && x.area);
    if (nearArea && hereAreas(loc).some(a => sameName(a.name, nearArea.name))) return { kind: 'already', loc, name: nearArea.name };
    const res = place ? await engineTravel(place.address, place.prefix ?? null) : await engineMove(choice);
    if (!res.ok) return { kind: ELSEWHERE, loc, noRoute: place?.label ?? null };
    stamp(msg, res.to, res.move);
    return { kind: 'move', loc: res.to };
}

export const WHICH_PREFIX = 'Which one do you mean?';
export const WAY_OUT_PREFIX = 'Which way out?';
/** Words that mean leaving the named place ("I leave the Drowned Rat", "flee out of town"). */
export const LEAVING_RE = /\b(leave|leaves|leaving|out|exit|exits|exiting|flee|flees|fleeing|fled|escape|escapes|escaping|get away)\b/i;
/** (a) unknown place: "You're not aware of such a place."  (b) known place, no allowed route: "You don't know a way to X from here." */
export const noticePrefix = noRoute => noRoute ? `You don't know a way to ${noRoute} from here.` : "You're not aware of such a place.";
export const unreachableText = (loc, noRoute = null) => `${noticePrefix(noRoute)} ${exitsText(loc)}`;
export const whichText = (cands, prefix = WHICH_PREFIX) => `${prefix} ${cands.map(x => x.label).join(', ')}`;

/**
 * Display-only game message: a system message, which SillyTavern never puts in the prompt.
 * kind 'which' lists candidate buttons; otherwise the not-aware / no-route text plus exit buttons.
 * Everything needed to rebuild the buttons is stored on the message, so they survive reloads.
 */
async function addNotice({ loc, noRoute = null, kind = 'unreachable', candidates = [], name = '', prefix = WHICH_PREFIX }) {
    const c = ctx();
    const which = kind === 'which';
    const cands = candidates.map(x => ({ label: x.label, name: x.name, ...(x.direction ? { direction: x.direction } : {}), ...(x.prefix ? { prefix: x.prefix } : {}), address: x.address }));
    const msg = {
        name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: which ? whichText(cands, prefix) : kind === 'already' ? alreadyText(loc, name) : unreachableText(loc, noRoute),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: kind, worldscrawl_notice_loc: loc?.address ?? null,
            worldscrawl_notice_prefix: which ? prefix : kind === 'already' ? `You're already in ${name}.` : noticePrefix(noRoute), ...(which ? { worldscrawl_notice_candidates: cands } : {}) },
    };
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
}

export function factsText(loc, move, toolsOn) {
    const who = whoMoves();
    const lines = [
        '[World state from the game engine. This is authoritative.]',
        `Current location: ${loc.name}${loc.subregion?.name && loc.subregion.name !== loc.name ? `, ${loc.subregion.name}` : ''}${loc.region?.name ? ` (${loc.region.name})` : ''}`,
        loc.effective_notes?.region ? `About ${loc.region?.name ?? 'the region'}: ${loc.effective_notes.region}` : '',
        loc.effective_notes?.subregion ? `About ${loc.subregion?.name ?? 'this area'}: ${loc.effective_notes.subregion}` : '',
        `This location: ${loc.description ?? ''}`,
        (loc.effective_notes?.region || loc.effective_notes?.subregion) ? 'If this location\'s own description contradicts the broader notes above, the location description wins.' : '',
        exitsText(loc).replace(/^Exits:/, 'Exits from here:'),
    ];
    if (move?.path?.length > 2) lines.push(`What just happened: ${who} travelled from ${move.path[0]} through ${move.path.slice(1, -1).join(', ')} to ${move.to_name}${move.stopped ? ' (the trip was cut short there)' : ''}. Narrate the journey briefly, in that order, ending with arriving at ${move.to_name}.`);
    else if (move) lines.push(`What just happened: ${who} moved ${move.direction} from ${move.from_name} to ${move.to_name}. Describe arriving at ${move.to_name}.`);
    else lines.push(`${who} has NOT moved this turn and is still at ${displayName(loc)}. Do not narrate travel to any other place.`);
    lines.push(toolsOn
        ? 'Do not invent locations or exits that are not listed.'
        : `You only narrate. The game engine controls movement: never move ${who} to a different location yourself, and do not invent locations or exits that are not listed. If a character tries to leave some other way, describe why they cannot.`);
    return lines.filter(Boolean).join('\n');
}

async function applyFacts() {
    const c = ctx();
    let text = '';
    try {
        const loc = await currentLocation();
        const ui = lastUserIndex(c.chat ?? []);
        const move = ui >= 0 ? c.chat[ui].extra?.[MOVE_KEY] : null;
        text = factsText(loc, move, toolsOn());
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

/** Generation interceptor (manifest.generate_interceptor): runs before every prompt is built. */
globalThis.worldscrawlInterceptor = async function (_chat, _size, abort, type) {
    if (type === 'quiet' || type === 'impersonate') return;
    try {
        const c = ctx();
        const chat = c.chat ?? [];
        const last = chat[chat.length - 1];
        const s = settings();
        if ((!type || type === 'normal') && last?.is_user && s.moveMode === 'typed'
            && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked) {
            const r = await parseIntent(last);
            await c.saveChat();
            if (r.kind === ELSEWHERE || r.kind === 'which' || r.kind === 'already') {
                abort(true); // no model call: the model would only narrate a trip that didn't happen
                await addNotice(r.kind === 'which' ? { loc: r.loc, kind: 'which', candidates: r.candidates, prefix: r.prefix ?? WHICH_PREFIX }
                    : r.kind === 'already' ? { loc: r.loc, kind: 'already', name: r.name } : { loc: r.loc, noRoute: r.noRoute });
                renderAllExits();
                return;
            }
            renderAllExits();
        }
        await applyFacts();
    } catch (e) { console.error('[WorldScrawl] interceptor failed', e); }
};

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-go',
        callback: (_args, dir) => goAction(String(dir ?? '').trim()),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction, e.g. north', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: move the party through an exit, then the model narrates the arrival.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-exits',
        callback: async () => { try { const t = exitsText(await currentLocation()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } },
        helpString: 'WorldScrawl: show the exits from the current location.',
    }));
}

// ---- Exits footer: display-only (DOM), never written into message.mes, so the model never sees it.
const exitsCache = new Map(); // address -> Promise<location|null>

/** /move returns the full new location: remember it so the next lookup needs no request. */
function primeCache(loc) { if (loc?.address && !exitsCache.has(loc.address)) exitsCache.set(loc.address, Promise.resolve(loc)); }

/**
 * Make sure these rooms (and the start room) are remembered, fetching all missing ones in ONE request
 * (GET /rooms). Used when rebuilding after a reload, instead of one /location request per room.
 */
function warmRooms(addresses) {
    const missing = [...new Set(addresses)].filter(a => a && !exitsCache.has(a));
    const needStart = !exitsCache.has('(start)');
    if (!missing.length) return needStart ? fetchLocationCached(null) : Promise.resolve();
    const batch = (async () => {
        try { const r = await api(`/rooms?addresses=${encodeURIComponent(missing.join(','))}`); return r.ok ? r.body : null; } catch { return null; }
    })();
    const remember = (key, p) => { exitsCache.set(key, p); p.then(v => { if (!v && exitsCache.get(key) === p) exitsCache.delete(key); }); };
    for (const a of missing) remember(a, batch.then(b => b?.rooms?.find(x => x.address === a) ?? null));
    if (needStart) remember('(start)', batch.then(b => { if (b?.start) primeCache(b.start); return b?.start ?? null; }));
    return batch;
}

function fetchLocationCached(address) {
    const key = address ?? '(start)';
    if (!exitsCache.has(key)) {
        const p = (async () => {
            try {
                const r = await api(address ? `/location/${encodeURIComponent(address)}` : '/start');
                if (r.ok && !address) primeCache(r.body);
                return r.ok ? r.body : null;
            } catch { return null; }
        })();
        p.then(v => { if (!v) exitsCache.delete(key); }); // don't cache failures (server down)
        exitsCache.set(key, p);
    }
    return exitsCache.get(key);
}

/** Location in effect at message `id`: latest stamped at or before it, else null (= start). */
function locationAt(id) {
    const chat = ctx().chat ?? [];
    for (let i = Math.min(id, chat.length - 1); i >= 0; i--) {
        const loc = chat[i]?.extra?.[LOC_KEY];
        if (loc) return loc;
    }
    return null;
}

export function exitsText(loc) {
    const exits = loc?.exits ?? [];
    return 'Exits: ' + (exits.length ? exitLabels(exits).join(', ') : 'none');
}

async function renderExits(id) {
    id = Number(id);
    const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!el) return;
    el.querySelector('.worldscrawl_exits')?.remove();
    const msg = ctx().chat?.[id];
    if (!settings().showExits || !msg || msg.is_user || msg.is_system) return;
    const loc = await fetchLocationCached(locationAt(id));
    const fresh = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!loc || !fresh || !settings().showExits) return;
    fresh.querySelector('.worldscrawl_exits')?.remove();
    const div = document.createElement('div');
    div.className = 'worldscrawl_exits';
    div.style.cssText = 'opacity:0.75;font-size:0.9em;margin-top:4px;font-style:italic;';
    const ch = ctx().chat ?? [];
    let lastReal = ch.length - 1;
    while (lastReal >= 0 && ch[lastReal]?.extra?.worldscrawl_notice) lastReal--;
    const isLast = id === lastReal;
    if (!isLast || !loc.exits?.length) div.textContent = exitsText(loc);
    else appendExitButtons(div, loc);
    (fresh.querySelector('.mes_block') ?? fresh).appendChild(div);
}

/** "Exits: " followed by one clickable entry per exit (shared by the footer and the can't-get-there message). */
function makeButton(label, title, onClick) {
    const b = document.createElement('span');
    b.className = 'worldscrawl_exit';
    b.title = title;
    b.style.cssText = 'cursor:pointer;text-decoration:underline;font-style:normal;';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

function appendExitButtons(el, loc) {
    el.append('Exits: ');
    const labels = exitLabels(loc.exits);
    loc.exits.forEach((e, i) => {
        if (i) el.append(', ');
        const b = makeButton(labels[i], `Go ${e.direction}`, () => goTarget({ direction: e.direction }));
        b.dataset.direction = e.direction;
        el.appendChild(b);
    });
}

function appendCandidateButtons(el, cands) {
    cands.forEach((x, i) => {
        if (i) el.append(', ');
        const b = makeButton(x.label, `Go to ${x.label}`, () => goTarget(x));
        b.classList.add('worldscrawl_candidate');
        b.dataset.address = x.address;
        el.appendChild(b);
    });
}

/** The latest can't-get-there message gets clickable exits (rebuilt from stored data, so it survives reloads). */
async function renderNotices() {
    const ch = ctx().chat ?? [];
    const last = ch.length - 1;
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid'));
        const msg = ch[id];
        if (!msg?.extra?.worldscrawl_notice) continue;
        const text = el.querySelector('.mes_text');
        if (!text) continue;
        const cands = msg.extra.worldscrawl_notice_kind === 'which' ? msg.extra.worldscrawl_notice_candidates ?? [] : null;
        const addr = msg.extra.worldscrawl_notice_loc;
        const loc = id === last && addr && !cands ? await fetchLocationCached(addr) : null;
        const isLatest = id === (ctx().chat?.length ?? 0) - 1;
        if (!isLatest || (cands ? !cands.length : !loc?.exits?.length)) {
            if (text.querySelector('.worldscrawl_exit')) text.textContent = msg.mes;
            continue;
        }
        text.textContent = '';
        text.append((msg.extra.worldscrawl_notice_prefix ?? "You can't get there from here.") + ' ');
        if (cands) appendCandidateButtons(text, cands); else appendExitButtons(text, loc);
    }
}

async function renderAllExits() {
    if (ctx().chat?.length) await warmRooms(chatAddresses()); // after a reload: one batch request instead of one per message
    renderNotices();
    document.querySelectorAll('#chat .worldscrawl_exits').forEach(e => e.remove());
    if (!settings().showExits) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderExits(el.getAttribute('mesid')));
}

async function testConnection() {
    const status = document.getElementById('worldscrawl_status');
    status.textContent = 'Testing...';
    try {
        const r = await api('/health');
        const tools = ctx().isToolCallingSupported() ? 'function calling is ON' : 'function calling is OFF or not supported by the current API/model';
        status.textContent = r.ok ? `Connected: ${r.body.locations} locations, start ${r.body.start}. Current: ${getStoredLocation() ?? '(start)'}. ${tools}.` : `Server error ${r.status}`;
    } catch (e) {
        status.textContent = e.message;
    }
}

function addSettingsPanel() {
    const html = `
<div class="worldscrawl_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>WorldScrawl</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label for="worldscrawl_url">Server URL</label>
      <input id="worldscrawl_url" class="text_pole" type="text">
      <div class="flex-container"><div id="worldscrawl_test" class="menu_button">Test connection</div></div>
      <small id="worldscrawl_status"></small>
      <label for="worldscrawl_who">Who moves (used in move messages and notes to the model; macros like {{user}} work)</label>
      <input id="worldscrawl_who" class="text_pole" type="text" placeholder="{{user}}">
      <label class="checkbox_label"><input id="worldscrawl_show_exits" type="checkbox"> Show exits footer</label>
      <div>Movement</div>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="commands"> Clicks and commands only</label>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="typed"> Clicks, commands and typed moves</label>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="tools"> Model moves with map tools (not recommended)</label>
      <label for="worldscrawl_nudge">Tool instructions (sent to the model each turn; leave empty to send nothing)</label>
      <textarea id="worldscrawl_nudge" class="text_pole" rows="4"></textarea>
      <div class="flex-container"><div id="worldscrawl_nudge_reset" class="menu_button">Restore default</div></div>
    </div>
  </div>
</div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    const input = document.getElementById('worldscrawl_url');
    input.value = settings().serverUrl;
    input.addEventListener('input', () => { settings().serverUrl = input.value.trim(); exitsCache.clear(); ctx().saveSettingsDebounced(); });
    const who = document.getElementById('worldscrawl_who');
    who.value = settings().whoMoves ?? DEFAULTS.whoMoves;
    who.addEventListener('input', () => { settings().whoMoves = who.value; applyFacts(); ctx().saveSettingsDebounced(); });
    const showExits = document.getElementById('worldscrawl_show_exits');
    showExits.checked = !!settings().showExits;
    showExits.addEventListener('change', () => { settings().showExits = showExits.checked; ctx().saveSettingsDebounced(); renderAllExits(); });
    document.querySelectorAll('input[name="worldscrawl_mode"]').forEach(r => {
        r.checked = r.value === settings().moveMode;
        r.addEventListener('change', () => { if (!r.checked) return; settings().moveMode = r.value; applyTools(); applyNudge(); applyFacts(); ctx().saveSettingsDebounced(); });
    });
    document.getElementById('worldscrawl_test').addEventListener('click', testConnection);
    const nudge = document.getElementById('worldscrawl_nudge');
    nudge.value = settings().nudge;
    nudge.addEventListener('input', () => { settings().nudge = nudge.value; applyNudge(); ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_nudge_reset').addEventListener('click', () => { nudge.value = settings().nudge = DEFAULT_NUDGE; applyNudge(); ctx().saveSettingsDebounced(); });
}

(function init() {
    settings();
    applyTools();
    registerSlashCommands();
    const { eventSource, eventTypes } = ctx();
    // ST pushes the tool-call record message into the chat right before this event and saves it right after.
    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, stampLocation);
    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        pendingLocation = null;
        if (ctx().chat?.length) await warmRooms(chatAddresses()); // one request for every room this chat needs (none if all remembered)
        await ensureStartStamp(); applyFacts(); setTimeout(renderAllExits, 0);
    });
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => { if (Number(id) === 0) ensureStartStamp().then(() => setTimeout(renderAllExits, 0)); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    for (const ev of ['MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderAllExits, 0));
    }
    addSettingsPanel();
    applyNudge();
    console.log('[WorldScrawl] loaded');
})();
