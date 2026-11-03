// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { setPrompts, hasPrompts } from './shared.mjs';
import { PLAYER, LOC_KEY, partyAddresses, positionOf, actorHistory } from './actors.mjs';
import { defaultWorldId, worldMissing } from './clock.mjs';
import { applyNudge, chatKey } from './expiry.mjs';
import { exitsCache, fetchLocationCached } from './footer.mjs';
import { CHANGE_KEY, MOVE_KEY, NOT_RUNNING, activeWorld, addChangeMessage, baseUrl, csrfHeaders, ctx, expiryPending, mapVersion, missingRoomFallback, noteMapVersion, syncWorld } from './index.js';
import { revealsDestination, syncDoors } from './movement.mjs';
import { patchSig, relocateFrom } from './patches.mjs';

// ---- Doors. A closed exit ("view": "closed", default for hidden/obscured) can be opened/closed by changes on
// messages (both sides share the exit's `door` id). Replay rule: an opened door that doesn't stay open
// (stays_open: exit > subregion > region, default false) counts as closed again once the party is in neither room.
const changesOf = m => { const c = m?.extra?.[CHANGE_KEY]; return Array.isArray(c) ? c : c ? [c] : []; };
/**
 * door id -> the last open_door / close_door change still in force at the end of `chat`. A door with no entry is in
 * its starting state (barrier.starts_open). One that doesn't stay open goes back to its starting state once the
 * party (the player, until someone follows them) is in neither room.
 */
export function doorOverrides(chat = ctx().chat ?? []) {
    const st = new Map();
    for (const m of chat) {
        for (const c of changesOf(m)) if ((c.type === 'open_door' || c.type === 'close_door') && c.door) st.set(c.door, c);
        const ex = m?.extra ?? {};
        for (const p of [...(ex[MOVE_KEY]?.via ?? []), ...partyAddresses(ex[LOC_KEY])].filter(Boolean))
            for (const [d, c] of st) { const rs = c.rooms ?? [c.from, c.to]; if (!c.stays_open && !rs.includes(roomToken(p)) && !rs.includes(p)) st.delete(d); }
    }
    return st;
}
/** door id -> the open_door change, for doors opened (by a change) at the end of `chat`. Pass this or doorOverrides() as `open` below. */
export const doorStates = (chat = ctx().chat ?? []) => new Map([...doorOverrides(chat)].filter(([, c]) => c.type === 'open_door'));
/** The exit's barrier, or null. */
export const barrierOf = e => e?.barrier ?? null;
/** Is nothing blocking this exit right now? */
export function isOpenNow(e, open = doorOverrides()) {
    const b = barrierOf(e);
    if (!b) return true;
    const c = e.door ? open.get(e.door) : null;
    if (c) return c.type !== 'close_door';
    return !!b.starts_open;
}
/** How much passes through an exit now: its sight/sound when unblocked, else its barrier's closed_sight/closed_sound. */
export const sightOf = (e, open = doorOverrides()) => (isOpenNow(e, open) ? e?.sight ?? 'partial' : barrierOf(e).closed_sight ?? 'none');
export const soundOf = (e, open = doorOverrides()) => (isOpenNow(e, open) ? e?.sound ?? 'partial' : barrierOf(e).closed_sound ?? 'partial');
// One-sided bars: door.barred_from ("this_side" / "other_side", already measured from the exit's own side by the
// server). A door with a bar starts barred; bar_door / unbar_door changes on messages (shared door id) change that,
// and stay as they were left (a bar doesn't drop by itself). Only the bar side can bar or unbar it.
/** door id -> the last bar_door / unbar_door change in `chat`. */
export function barStates(chat = ctx().chat ?? []) {
    const st = new Map();
    for (const m of chat) for (const c of changesOf(m)) if ((c.type === 'bar_door' || c.type === 'unbar_door') && c.door) st.set(c.door, c);
    return st;
}
/** Is this door barred right now (from either side)? */
export const isBarredNow = (e, bars = barStates()) => { const b = barrierOf(e); if (!b || !['this_side', 'other_side'].includes(b.barred_from)) return false; const c = e.door ? bars.get(e.door) : null; return c ? c.type === 'bar_door' : true; };
/** Barred, with the bar on the far side: it won't open from here. */
export const isBarredAway = (e, bars = barStates()) => barrierOf(e)?.barred_from === 'other_side' && isBarredNow(e, bars);
/** The bar is on this side (it can be barred / unbarred from here). */
export const barHere = e => barrierOf(e)?.barred_from === 'this_side';
/** A closed barrier that can't be opened now (rubble, a barricade, locked, or barred from the other side). */
export const isStuck = (e, open = doorOverrides(), bars = barStates()) => { const b = barrierOf(e); return !!b && !isOpenNow(e, open) && (b.openable === false || !!b.locked || isBarredAway(e, bars)); };
/** What can be seen through an exit now (legacy one word): "closed" (a closed barrier), "none" or "open". */
export const viewOf = (e, open = doorOverrides()) => (!isOpenNow(e, open) ? 'closed' : sightOf(e, open) === 'none' ? 'none' : 'open');
const barrierWord = e => (barrierOf(e)?.openable === false ? 'way' : 'door');
// rooms: opaque tokens of both sides of the door (from the server, even behind an obscured door, without saying
// where it leads); used only for the auto-close replay, never in a prompt.
const roomTokens = new Map(); // address -> room_token, filled as rooms are fetched
export const roomToken = a => roomTokens.get(a) ?? a;
export const doorChange = (type, here, e) => ({ type, from: here.address, direction: e.direction, door: e.door, rooms: e.door_rooms ?? [roomToken(here.address), ...(revealsDestination(e) && e.to ? [roomToken(e.to)] : [])], stays_open: !!(e.barrier?.stays_open ?? e.stays_open) });
/** Closed doors here that can be opened / open doors here that can be closed / closed ones that won't open (locked, rubble). */
export function doorCandidates(here, open = doorOverrides()) {
    const vis = here.exits.filter(e => e.door && barrierOf(e) && (!e.hidden || revealsDestination(e)));
    const openable = e => barrierOf(e).openable !== false;
    return { toOpen: vis.filter(e => !isOpenNow(e, open) && !isStuck(e, open)), toClose: vis.filter(e => isOpenNow(e, open) && openable(e)), stuck: vis.filter(e => isStuck(e, open)) };
}
const stuckWhy = e => (barrierOf(e).openable === false ? 'is blocked and can\'t be opened' : barrierOf(e).locked ? 'is locked' : isBarredAway(e) ? 'is barred from the other side and won\'t budge (a bar on the far side holds it shut; it is not locked and has no keyhole)' : 'is stuck');
/** The changes that open a door: lifting the bar first when it is barred on this side. */
export const openChanges = (here, e) => [...(barHere(e) && isBarredNow(e) ? [doorChange('unbar_door', here, e)] : []), doorChange('open_door', here, e)];
/** A single change stays a plain object (the usual stamp shape); several become a list. */
const oneOrList = l => (l.length === 1 ? l[0] : l);
/** /ws-bar <dir>, /ws-unbar <dir>: only from the side the bar is on. Barring an open door closes it first. */
export async function barAction(kind, arg) {
    const here = await currentLocation();
    const want = String(arg ?? '').trim().toLowerCase();
    const vis = here.exits.filter(e => e.door && barrierOf(e)?.barred_from && (!e.hidden || revealsDestination(e)));
    const mine = vis.filter(barHere);
    const e = vis.find(x => x.direction.toLowerCase() === want) ?? (!want && mine.length === 1 ? mine[0] : null);
    if (!e) { toastr.warning(mine.length ? `Doors you can ${kind} here: ${mine.map(x => x.direction).join(', ')}` : `No door with a bar on this side here.`); return ''; }
    if (!barHere(e)) { toastr.warning(`The bar on the ${e.direction} door is on the other side.`); return ''; }
    const barred = isBarredNow(e);
    if ((kind === 'bar') === barred) { toastr.info(`The ${e.direction} door is already ${barred ? 'barred' : 'unbarred'}.`); return ''; }
    const ch = kind === 'bar' ? [...(isOpenNow(e) ? [doorChange('close_door', here, e)] : []), doorChange('bar_door', here, e)] : [doorChange('unbar_door', here, e)];
    await addChangeMessage(`[Engine: the ${e.direction} door is now ${kind === 'bar' ? 'barred' : 'unbarred'}.]`, ch);
    return '';
}
/** /ws-open <dir>, /ws-close <dir> */
export async function doorAction(kind, arg) {
    const here = await currentLocation();
    const { toOpen, toClose, stuck } = doorCandidates(here);
    const list = kind === 'open' ? toOpen : toClose;
    const want = String(arg ?? '').trim().toLowerCase();
    const s = kind === 'open' && stuck.find(x => x.direction.toLowerCase() === want);
    if (s) { toastr.warning(`The ${s.direction} ${stuckWhy(s)}.`); return ''; }
    const e = list.find(x => x.direction.toLowerCase() === want);
    if (!e) { toastr.warning(list.length ? `Doors you can ${kind} here: ${list.map(x => x.direction).join(', ')}` : `No door to ${kind} here.`); return ''; }
    await addChangeMessage(`[Engine: the ${e.direction} door ${kind === 'open' ? 'is now open' : 'is now closed'}.]`, kind === 'open' ? oneOrList(openChanges(here, e)) : doorChange('close_door', here, e));
    return '';
}
export const cacheInfo = () => ({ size: exitsCache.size, mapVersion });
export const cacheKeys = () => [...exitsCache.keys()];

/** Load the prompts in use (default + the selected profile) from the plugin, once, and again after the editor saves. */
let promptsLoading = null;
export function ensurePrompts(force = false) {
    if (hasPrompts() && !force) return Promise.resolve();
    promptsLoading = (async () => {
        const res = await fetch(`${baseUrl()}/prompts/active`, { headers: csrfHeaders() });
        if (!res.ok) throw new Error(`WorldScrawl could not load its prompts (server answered ${res.status}). ${NOT_RUNNING()}`);
        const { prompts } = await res.json();
        setPrompts(prompts);
        applyNudge();
    })().finally(() => { promptsLoading = null; });
    return promptsLoading;
}

async function api(path, options = {}) {
    let res;
    try {
        // JSON content type only when sending a body: on a GET it would force a CORS preflight (an extra OPTIONS request).
        const headers = { ...csrfHeaders(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) };
        const sep = path.includes('?') ? '&' : '?';
        const wid = activeWorld || defaultWorldId; // always name the world once it's known
        const scoped = !path.startsWith('/worlds') && !path.startsWith('/open-folder') && !/[?&]world=/.test(path) && wid ? `${path}${sep}world=${encodeURIComponent(wid)}` : path;
        res = await fetch(baseUrl() + scoped, { ...options, headers });
    } catch (e) {
        throw new Error(`WorldScrawl server not reachable at ${baseUrl()} (${e.message}). ${NOT_RUNNING()}`);
    }
    if (!path.startsWith('/worlds')) noteMapVersion(res.headers.get('X-WorldScrawl-Map-Version'));
    const body = await res.json().catch(() => ({}));
    if (res.status === 404 && body?.detail?.error === 'world_not_found') worldMissing(body.detail.world);
    return { ok: res.ok, status: res.status, body };
}

/** Latest player position stored on a message (after merge redirects), or null if this chat has none yet. */
export function getStoredLocation() {
    const st = storedStamp();
    return st ? relocateFrom(st.address, st.index, ctx().chat ?? []) : null;
}
/** Earlier stamped positions for one actor before message `before`, newest first, without repeats (the move history). */
function stampHistory(before, actor = PLAYER) {
    return actorHistory(ctx().chat ?? [], before, actor);
}
/** The raw player position (before merge redirects) and the message it was stamped on. */
function storedStamp(actor = PLAYER) {
    const chat = ctx().chat ?? [];
    const p = positionOf(chat, chat.length - 1, actor);
    return p ? { address: p.address, index: p.index } : null;
}

/** Current location, from the in-memory cache (one shared request per address; /start fetched once). */
async function currentLocation() {
    syncWorld();
    await syncDoors();
    const stored = getStoredLocation();
    if (stored && expiryPending?.from === stored && expiryPending.chat === chatKey()) { const t = await fetchLocationCached(expiryPending.to); if (t) return t; }
    if (stored) {
        const loc = await fetchLocationCached(stored);
        if (loc) return loc;
        if (patchSig()) return missingRoomFallback(stored); // not in this chat's patched map (moved, merged, removed): resolve it, even when the base world still has it
        const r = await api(`/location/${encodeURIComponent(stored)}`).catch(() => null);
        if (r?.status === 404 && r.body?.detail?.error === 'world_not_found') { syncWorld(); const again = await fetchLocationCached(stored); if (again) return again; }
        else if (r?.status === 404) return missingRoomFallback(stored);
    }
    const start = await fetchLocationCached(null);
    if (!start) throw new Error(`WorldScrawl server not reachable at ${baseUrl()}, or /start failed. ${NOT_RUNNING()}`);
    return start;
}

export { api, barrierWord, changesOf, currentLocation, roomTokens, stampHistory, storedStamp, stuckWhy };
