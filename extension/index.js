// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// where each actor is; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// Positions are stamped on chat messages (message.extra.worldscrawl_location) so that deleting or swiping
// a message rolls them back. A string stamp is the player's position (old chats, and still what we write
// when only the player moved). A per-actor stamp is {actorId: address}. There is no stored party: the party
// is the player (id "player") plus whoever is following them, and nobody follows yet.
import { LOOK_RE, MOVE_RE, lookOnly, stayPutLine, WAIT_TAG, waitArgs, parseWaitTag } from './words.mjs';
import { messageActivity } from './activity.mjs';
import { timeLabel } from './timelabels.mjs';
import { DECIDED_KEY, noticeIdOf, newNoticeId, decisionOf, isDecided, markDecided, unmarkDecided, once, noticeRow, lockRow, markPending, NOTICE_CSS, resolvedText } from './notices.mjs';
import { addCallNote, markCall, narratorNote, narratorStart, narratorFailure } from './calllog.mjs';
import { render as P, setPrompts, hasPrompts } from './prompts.mjs';
import { PLAYER, LOC_KEY, playerAddress, partyAddresses, positionOf, placeStamp, actorHistory } from './actors.mjs';
import { NPC_KEY, SUGGEST_AFTER, declinesInScene, exportRecord, focusRules, followersAt, framesOf, freeId, nameIn, normName, absentAt, npcAt, npcPlayState, npcSlices, npcWhy, narratorView, unsavedPeople, whoAt, presentAt, readBack, readRememberAnswer, recordDiff, npcTiers, askedLoreNames, takeNameFlags, npcForName, resolveSchedulePlace, sightCheck, stampSummary, takeNpcTags, NPC_FLAG_KEY, flaggedPeople, sceneStartOf, takeNpcFlags, renderNpcTokens, takeLoreFlags, loreFor, addLoreRequest, activeLore, LORE_KEY } from './npc.mjs';
export { setPrompts, P as render };
const MODULE = 'worldscrawl';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: '', nudge: DEFAULT_NUDGE, showExits: true, autoKeep: false, autoKeepWaits: false, narrateExpiries: true, proactiveDiscovery: false, flagTags: true, moveMode: 'typed', whoMoves: '{{user}}', world: '', enableNewChats: false, showEditMessages: false };
export const OFF_NOTICE = 'WorldScrawl is turned off.';
const ENABLED_KEY = 'worldscrawl_enabled'; // in chat_metadata: this chat's on/off (saved with the chat, not rolled back by swipes)
/** Does this chat already have anything WorldScrawl stamped on it? */
export const chatHasStamps = (chat = ctx().chat ?? []) => chat.some(m => { const e = m?.extra; return e && (e[LOC_KEY] || e[MOVE_KEY] || e[WORLD_KEY] || e[CHANGE_KEY] || e.worldscrawl_notice); });
/**
 * Is WorldScrawl on in this chat? The chat's saved choice; else on if the chat already has WorldScrawl stamps
 * (older chats); else the global "Enable in new chats" setting (default off). When off it behaves as if uninstalled.
 */
export function isOn() {
    const v = ctx().chatMetadata?.[ENABLED_KEY];
    if (typeof v === 'boolean') return v;
    return chatHasStamps() || !!settings().enableNewChats;
}
const WORLD_KEY = 'worldscrawl_world'; // {id, version, rebase?, at?, from?}: which world this chat is built on (latest stamp wins)
const CHANGE_KEY = 'worldscrawl_change'; // {type: 'add_exit'|'remove_exit', ...} on the system message that made the change
const MODES = ['commands', 'typed', 'tools'];
const MOVE_KEY = 'worldscrawl_move'; // {direction, from, from_name, to, to_name} on the message that moved
const WAITCARD_KEY = 'worldscrawl_waitcard'; // {swipe, seconds, sleep, label, until, amount}: a narrator wait waiting for Keep / Adjust / Discard
const WAIT_KEY = 'worldscrawl_wait'; // {seconds, sleep, label, before}: on the message where time passed without moving
const FACTS_KEY = 'worldscrawl_facts';
const REMINDER_KEY = 'worldscrawl_arrival_reminder'; // depth 0: right after the latest user message
const TOOL_NAMES = ['ws_look', 'ws_move', 'ws_flag', 'ws_wait', 'ws_npc'];
const PATCH_KEY = 'worldscrawl_patches'; // [{type: 'patch', ops, relocate, swipe, ...}] on the message where a map change settled
const FLAG_KEY = 'worldscrawl_flag'; // {swipe, loc, note, start, status, proposal}: a flagged message's review card
const FLAGHINT_KEY = 'worldscrawl_flaghint';
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

/** The map server: SillyTavern's own WorldScrawl plugin route, unless the settings name another server. */
export const PLUGIN_URL = '/api/plugins/worldscrawl';
const LEGACY_URL = /^https?:\/\/(127\.0\.0\.1|localhost):5100\/*$/; // the old Python server's default: now the plugin
const baseUrl = () => { const u = String(settings().serverUrl || '').trim(); return !u || LEGACY_URL.test(u) ? PLUGIN_URL : u.replace(/\/+$/, ''); };
/** SillyTavern's CSRF token, for requests to its own plugin routes (same origin only). */
const csrfHeaders = () => { if (/^https?:/.test(baseUrl())) return {}; const t = ctx().getRequestHeaders?.()?.['X-CSRF-Token']; return t ? { 'X-CSRF-Token': t } : {}; };
const NOT_RUNNING = () => baseUrl() === PLUGIN_URL
    ? 'Is the WorldScrawl server plugin installed in SillyTavern/plugins/worldscrawl, with enableServerPlugins: true in config.yaml? Restart SillyTavern after changing either.'
    : 'Is it running?';

let mapVersion = null;
/** Every server reply carries the map version; when it changes (map files edited, server restarted) drop remembered rooms. */
export function noteMapVersion(v) {
    if (!v) return;
    if (mapVersion && v !== mapVersion) { exitsCache.clear(); doorInfo.clear(); doorFetched.clear(); console.log(`[WorldScrawl] map changed (${mapVersion} -> ${v}); cleared remembered rooms`); }
    mapVersion = v;
    const cw = chatWorld();
    const key = `${cw?.id}|${cw?.version}|${v}`;
    if (cw?.version && cw.version !== v && !versionWarned.has(key)) {
        versionWarned.add(key);
        console.warn(`[WorldScrawl] this chat was built on ${cw.id} version ${cw.version}, the server has ${v}; continuing anyway`);
        try { toastr.warning(`WorldScrawl: the map of "${cw.id}" changed since this chat started. Missing rooms or exits will be skipped.`); } catch {}
    }
}
const versionWarned = new Set();

// ---- Worlds. Which world a chat is built on is stamped on its messages (latest stamp wins), so deleting or
// swiping away a rebase stamp puts the chat back on the previous world. No stamp = the server's default world.
let activeWorld = ''; // '' = server default
let defaultWorldId = null; // learned from GET /worlds; '' and the default id are the same world
const worldNames = new Map(); // id -> display name (from GET /worlds and saves)
const worldLiving = new Map(); // id -> true for living saves (can be saved over)
const listedWorlds = new Set(); // ids in the latest GET /worlds (the server rescans its folder on each list)
const missingWorlds = new Set(); // world ids the server says no longer exist
const worldTimes = new Map(); // id -> {calendar, start_date} (from GET /worlds and saves)
const worldCasts = new Map(); // id -> { npcs, places: Set, names, labels }
const rememberWorlds = body => {
    if (body?.default) defaultWorldId = body.default;
    if (body?.worlds) { listedWorlds.clear(); for (const w of body.worlds) { listedWorlds.add(w.id); missingWorlds.delete(w.id); worldNames.set(w.id, w.name); worldLiving.set(w.id, !!w.living); if (w.start_date) worldTimes.set(w.id, { calendar: w.calendar, start_date: w.start_date, weather: w.weather }); if (Array.isArray(w.cast)) worldCasts.set(w.id, { npcs: w.cast, places: new Set(w.places ?? []), names: w.place_names ?? [], labels: w.place_labels ?? {} }); } }
};

// ---- Game clock. Travel and waiting take time: each move or wait stamps its seconds on its message (move.seconds, wait.seconds), so swipes keep
// them and deleting the message undoes them. Clock = the chat world's start_date + the seconds stamped after the latest
// rebase (a save bakes everything before it into the saved world's start_date).
let calendarLib = null;
/** calendar.mjs, served by the plugin (also used by the map window); null until loaded or if unavailable. */
export async function loadCalendar() {
    if (calendarLib) return calendarLib;
    try { calendarLib = await import(`${baseUrl()}/ui/calendar.mjs`); } catch (e) { console.warn('[WorldScrawl] calendar unavailable:', e.message); }
    if (calendarLib && !weatherLib) { try { weatherLib = await import(`${baseUrl()}/ui/weather.mjs`); } catch (e) { console.warn('[WorldScrawl] weather unavailable:', e.message); } }
    return calendarLib;
}
let weatherLib = null;
/** Weather where `loc` is at the chat's current game time ({line, short, ...} from weather.mjs placeWeather), or null. */
export function placeWeatherNow(loc, chat = ctx().chat ?? []) {
    const t = worldTimes.get(activeWorld || defaultWorldId), d = gameDate(chat);
    if (!weatherLib || !t?.weather || !loc?.weather || !d) return null;
    try { return weatherLib.placeWeather(t.weather, loc.weather, weatherLib.absSeconds(d, t.calendar), t.calendar); } catch (e) { console.warn('[WorldScrawl] weather:', e.message); return null; }
}
/** Seconds of travel stamped on this chat's messages since its world's start_date. */
/** Game seconds elapsed at message `index` (the shared clock lookup; kept waits and moves only, wait cards count once kept). */
export function clockAt(index, chat = ctx().chat ?? []) {
    const base = chatWorld(chat);
    return calendarLib ? calendarLib.clockAt(chat, index, base?.rebase ? base.index : -1) : 0;
}
export function chatElapsed(chat = ctx().chat ?? []) {
    const base = chatWorld(chat);
    const from = base?.rebase ? base.index : -1;
    return calendarLib ? calendarLib.sumTravel(chat, from) : 0;
}
/** The chat's current game date ({weekday, part, time, ...} from calendar.mjs dateAt), or null if unknown. */
export function gameDate(chat = ctx().chat ?? []) {
    const t = worldTimes.get(activeWorld || defaultWorldId);
    if (!calendarLib || !t) return null;
    try { return calendarLib.dateAt(chatElapsed(chat), t.start_date, t.calendar); } catch (e) { console.warn('[WorldScrawl] clock:', e.message); return null; }
}
/**
 * The world requests actually go to. Normally the chat's stamped world; if that world's folder is gone, the world it
 * was saved from (the switch stamp's "from", if that still exists), else the default. Stamps are never changed.
 */
export function effectiveWorld(chat = ctx().chat ?? []) {
    let w = chatWorld(chat)?.id ?? '';
    for (let i = chat.length - 1; i >= 0 && w && missingWorlds.has(w); i--) {
        const st = chat[i]?.extra?.[WORLD_KEY];
        if (st?.id === w) w = st.rebase && st.from ? st.from : '';
    }
    return w && missingWorlds.has(w) ? '' : w;
}
/** The server says this chat's world is gone: remember it, switch to the fallback, post the one-time notice. */
function worldMissing(id) {
    if (!id || missingWorlds.has(id)) return;
    missingWorlds.add(id);
    console.warn(`[WorldScrawl] world ${id} not found; falling back to ${effectiveWorld() || '(default)'}`);
    setTimeout(() => postMissingWorldNotice(id), 0);
}
async function postMissingWorldNotice(id) {
    const c = ctx();
    if (!isOn() || chatWorld()?.id !== id) return;
    if ((c.chat ?? []).some(m => m?.extra?.worldscrawl_notice_kind === 'missing_world' && m.extra.worldscrawl_notice_world === id)) return; // once per chat
    rememberWorlds((await api('/worlds').catch(() => null))?.body);
    const fb = effectiveWorld();
    const worlds = [...listedWorlds].map(w => ({ id: w, name: worldName(w) }));
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: `[Engine: the world "${chatWorld()?.name ?? worldName(id)}" this chat was built on is missing. Using "${worldName(fb)}" for now. Move this chat to: ${worlds.map(w => w.name).join(', ')}]`,
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing_world', worldscrawl_notice_world: id, worldscrawl_notice_worlds: worlds,
            worldscrawl_notice_prefix: `[Engine: the world "${chatWorld()?.name ?? worldName(id)}" this chat was built on is missing. Using "${worldName(fb)}" for now. Move this chat to:` } };
    c.chat.push(msg); c.addOneMessage(msg); await c.saveChat();
    renderAllExits();
}
/** Picker button on the missing-world notice: move the chat onto that world (a rebase stamped on the notice; delete it to undo). */
export async function moveChatToWorld(id, index) {
    const c = ctx();
    const msg = c.chat?.[index];
    if (!msg) return;
    const list = (await api('/worlds').catch(() => null))?.body;
    rememberWorlds(list);
    const info = list?.worlds?.find(w => w.id === id);
    if (!info) { toastr.warning('That world is gone too.'); return; }
    msg.extra[WORLD_KEY] = { id: info.id, name: info.name, version: info.map_version, rebase: true, at: index, from: chatWorld()?.id ?? null };
    await c.saveChat();
    lastSyncChat = null;
    await rebuildFromChat();
    toastr.success(`This chat now uses the world "${info.name}".`);
}
let placeholderAuto = true; // is the Save box placeholder a generated name (vs. the living world's own name)?
/** What the user sees for a world: its display name, else its id. */
export const worldName = id => worldNames.get(id || defaultWorldId) ?? (id || defaultWorldId || 'World');
let lastSyncChat = null;
export function chatWorld(chat = ctx().chat ?? []) {
    for (let i = chat.length - 1; i >= 0; i--) { const w = chat[i]?.extra?.[WORLD_KEY]; if (w?.id) return { ...w, index: i }; }
    return null;
}
/** Knowledge seeded from a "with knowledge" world when this chat started (on message 0, so swipes keep it). */
export function worldSeed(chat = ctx().chat ?? []) {
    for (const m of chat) { const sd = m?.extra?.[WORLD_KEY]?.seed; if (sd) return sd; }
    return null;
}
/** Point all requests at the chat's world; switching worlds drops everything remembered about the old one. */
export function syncWorld() {
    const w = effectiveWorld();
    const same = (w || defaultWorldId) === (activeWorld || defaultWorldId);
    if (w !== activeWorld && same) activeWorld = w; // same world, just named: keep what's remembered
    const chatId = ctx().chatId ?? ctx().getCurrentChatId?.() ?? null;
    if (w !== activeWorld && lastSyncChat === chatId && chatId) { try { toastr.info(`WorldScrawl: this chat now uses the world "${worldName(w)}".`); } catch {} }
    lastSyncChat = chatId;
    if (w !== activeWorld) {
        console.log(`[WorldScrawl] world: ${activeWorld || '(default)'} -> ${w || '(default)'}`);
        activeWorld = w; exitsCache.clear(); doorInfo.clear(); doorFetched.clear(); mapVersion = null;
    }
    return activeWorld;
}
/** World changes (dug/removed exits) to apply: those stamped after the latest rebase (earlier ones are baked into that world). */
export function chatChanges(chat = ctx().chat ?? []) {
    const base = chatWorld(chat);
    const from = base?.rebase ? base.index : -1;
    const out = [];
    chat.forEach((m, i) => {
        const c = m?.extra?.[CHANGE_KEY]; if (c && i > from) out.push(...(Array.isArray(c) ? c : [c]));
        if (i > from) for (const p of patchesOn(m)) out.push({ ...p, _msg: i });
    });
    return out;
}
/** A room with this chat's changes applied: exits dug from it added, removed exits dropped. */
async function applyChanges(loc) {
    // A two-way dig is two one-way exits; the far side's is the return exit.
    const changes = chatChanges().flatMap(c => c.type !== 'dig' ? [c]
        : [{ type: 'add_exit', from: c.from, direction: c.direction, to: c.to, description: c.description },
           { type: 'add_exit', from: c.to, direction: c.return_direction, to: c.from, description: c.return_description }]).filter(c => c.from === loc?.address);
    if (!loc || !changes.length) return loc;
    let exits = [...loc.exits];
    const views = [...(loc.views ?? [])]; // hand-written views come first (server), then this chat's view links
    for (const c of changes) {
        if (c.type === 'view_link') {
            if (views.some(v => v.address === c.to)) continue;
            const t = await fetchRaw(c.to) ?? await newRoom(c.to);
            if (t) views.push({ address: t.address, name: t.name, display_name: displayName(t), summary: firstSentence(t.description) });
        } else if (c.type === 'remove_exit') exits = exits.filter(e => e.direction.toLowerCase() !== String(c.direction).toLowerCase());
        else if (c.type === 'add_exit') {
            const t = await fetchRaw(c.to) ?? await newRoom(c.to);
            if (!t) { console.warn(`[WorldScrawl] dug exit ${c.direction} from ${c.from}: ${c.to} is not in this world; skipped`); continue; }
            if (exits.some(e => e.direction.toLowerCase() === String(c.direction).toLowerCase())) continue;
            const same = t.subregion?.id === loc.subregion?.id && t.region?.id === loc.region?.id;
            const label = same || t.subregion?.label_rooms || t.name === t.subregion?.name ? t.name : t.subregion?.entrance === t.address ? t.subregion.name : `${t.subregion?.name}, ${t.name}`;
            exits.push({ direction: c.direction, to: t.address, to_name: t.name, to_display_name: displayName(t), to_label: label, to_subregion: t.subregion, to_region: t.region, ...(c.description ? { description: c.description } : {}), dug: true });
        }
    }
    return { ...loc, exits, views };
}
export const firstSentence = t => String(t ?? '').trim().split(/(?<=[.!?])\s/)[0].slice(0, 160);

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
/** The exit's barrier (older data: "view": "closed" = an ordinary door), or null. */
export const barrierOf = e => e?.barrier ?? (e?.view === 'closed' ? { closed_sight: 'none', closed_sound: 'partial', openable: true, starts_open: false, locked: false } : null);
/** Is nothing blocking this exit right now? */
export function isOpenNow(e, open = doorOverrides()) {
    const b = barrierOf(e);
    if (!b) return true;
    const c = e.door ? open.get(e.door) : null;
    if (c) return c.type !== 'close_door';
    return !!b.starts_open;
}
/** How much passes through an exit now: its sight/sound when unblocked, else its barrier's closed_sight/closed_sound. */
export const sightOf = (e, open = doorOverrides()) => (isOpenNow(e, open) ? e?.sight ?? (e?.view === 'none' ? 'none' : 'partial') : barrierOf(e).closed_sight ?? 'none');
export const soundOf = (e, open = doorOverrides()) => (isOpenNow(e, open) ? e?.sound ?? (e?.view === 'none' ? 'none' : 'partial') : barrierOf(e).closed_sound ?? 'partial');
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
        try { (await import(`${baseUrl()}/ui/prompts.mjs`)).setPrompts(prompts); } catch (e) { console.warn('[WorldScrawl] prompt module unavailable:', e.message); }
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

/** The saved room isn't in this chat's effective map (removed, merged, swiped or deleted away, or a temporary change expired):
 *  the server's blanket position resolver picks a real room (merge redirect, a surviving neighbour, the subregion/region
 *  entrance, the world start). One short system notice carries the new location (delete it to undo) and the narrator is told once. */
async function missingRoomFallback(stored) {
    const st = storedStamp();
    const r = await api('/resolve', { method: 'POST', body: JSON.stringify({ address: st?.address ?? stored, since: st?.index ?? null, history: stampHistory(st?.index ?? (ctx().chat ?? []).length), ...mapCtx() }) }).catch(() => null);
    let to = r?.ok && r.body?.address ? await fetchLocationCached(r.body.address) : null;
    if (!to) to = await fetchLocationCached(null);
    if (!to) throw new Error('WorldScrawl: /start failed.');
    const c0 = ctx(), once = `${chatKey()}|${stored}|${(c0.chat ?? []).length}|${chatElapsed()}`;
    if (r?.body?.expired && settings().narrateExpiries !== false && typeof c0.generate === 'function' && !expiryNarrated.has(once)) {
        // Narrated expiry: pick where they end up first (own pick-one call, the way in by default), move them in memory,
        // then one automatic narrator reply tells why and how; that reply carries the location stamp.
        expiryNarrated.add(once);
        const opts = expiryOptions(r.body.options ?? []), room = r.body.expired_room ?? { name: stored };
        let dest = opts.find(o => o.address === to.address) ?? opts[0] ?? null;
        await ensurePrompts();
        if (opts.length > 1 && typeof c0.generateRaw === 'function') {
            try { dest = await askValid('expiry', expiryPickPrompt(room, opts, dest?.key), pickKey(opts)) ?? dest; } catch (e) { console.warn('[WorldScrawl] expiry pick failed:', e.message); }
        }
        const picked = dest ? await fetchLocationCached(dest.address) : null;
        if (picked) to = picked;
        const via = (r.body.options ?? []).find(o => o.address === to.address)?.direction ?? '';
        const p = expiryPending = { chat: chatKey(), from: stored, to: to.address, via, line: '' };
        try { p.line = expiryNarrationLine(room, to, via, partyText(), excerptOf(c0.chat?.[room.change?.msg]?.mes)); } catch {}
        console.warn(`[WorldScrawl] ${stored} expired; narrating the move to ${to.address}`);
        setTimeout(() => { triggerExpiryNarration(p).catch(e => console.error('[WorldScrawl] expiry narration', e)); }, 0);
        return to;
    }
    console.warn(`[WorldScrawl] location ${stored} is not in world ${activeWorld || '(default)'}; resolved to ${to.address} (${r?.body?.how ?? 'start'})`);
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: r?.body?.expired ? expiredNotice(to, r.body.via) : `[Engine: that place no longer exists in this world. You're now in ${displayName(to)}.]`,
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing', worldscrawl_notice_from: stored, ...(r?.body?.expired ? { worldscrawl_notice_expired: true } : {}), [LOC_KEY]: to.address } };
    c.chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    return to;
}
// ---- Narrated expiries: one pending move per chat, held in memory until the automatic narrator reply stamps it.
let expiryPending = null;
const expiryNarrated = new Set();
const chatKey = () => { try { return String(ctx().getCurrentChatId?.() ?? ''); } catch { return ''; } };
/** The places a run-out room's exits still reach, as pick-one keys (the way they came in first). */
export const expiryOptions = list => { const taken = new Set(); return list.map(o => ({ key: keyFor(o.name ?? o.address, taken), label: `${o.name ?? o.address}${o.direction ? ` (out through the ${o.direction})` : ''}`, address: o.address, direction: o.direction ?? '' })); };
export const expiryPickPrompt = (room, opts, def) => P('narration.expiry_pick', { party: partyText(), place: room.name ?? '', ended: room.change?.ended ?? 'its time ran out', description: room.description ?? '', options: optionLines(opts), default: def ?? opts[0]?.key ?? '' });
/** A short excerpt of the message that made the place (about 240 characters, one line). */
export const excerptOf = text => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > 240 ? `${t.slice(0, 237).replace(/\s+\S*$/, '')}...` : t; };
export function expiryNarrationLine(room, to, via, who, excerpt) {
    const sum = room.change ? [room.change.note, ...(Array.isArray(room.change.summary) ? room.change.summary : [room.change.summary])].filter(Boolean).join('; ') : '';
    return P('narration.expired', { place: room.name ?? '', ended: room.change?.ended ?? 'its time ran out', description: room.description || '(none)', change: sum || '(unknown)', excerpt: excerpt || '(none)', party: who, to: displayName(to), via: via ? ` (out through the ${via})` : '' });
}
/** Fire the automatic narrator reply (like ST's own reply); if none arrives, fall back to the plain notice. */
async function triggerExpiryNarration(p) {
    if (expiryPending !== p || p.used) return; // a reply already in progress carries it
    try { await ctx().generate('normal', { automatic_trigger: true }); } catch (e) { console.warn('[WorldScrawl] expiry narration failed:', e.message); }
    if (expiryPending === p) { expiryPending = null; await postExpiredNotice(p.from, p.to, p.via); }
}
async function postExpiredNotice(from, toAddr, via) {
    const c = ctx(), to = await fetchLocationCached(toAddr);
    if (!to) return;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: expiredNotice(to, via),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing', worldscrawl_notice_from: from, worldscrawl_notice_expired: true, [LOC_KEY]: to.address } };
    c.chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
}
/** The narrator reply that told the expiry gets the move's stamp (delete it to rewind). */
async function stampExpiryReply(id) {
    const p = expiryPending, c = ctx(), m = c.chat?.[id];
    if (!p || p.chat !== chatKey() || !m || m.is_user || m.is_system) return;
    m.extra = m.extra ?? {};
    m.extra[LOC_KEY] = p.to; m.extra.worldscrawl_expiry_narrated = { from: p.from, to: p.to };
    expiryPending = null;
    await c.saveChat?.();
}
/** The map as the last narrator reply saw it: changes up to it (with later Turn off / Turn on reverted), its clock and room.
 *  Limitation: a change undone (removed) after that reply is gone from the chat, so it can't be put back here. */
export function narratedView(chat) {
    let L = -1;
    for (let i = chat.length - 1; i >= 0; i--) { const m = chat[i]; if (m && !m.is_user && !m.is_system) { L = i; break; } }
    if (L < 0) return null;
    let address = null;
    for (let i = L; i >= 0 && !address; i--) address = playerAddress(chat[i]?.extra?.[LOC_KEY]);
    if (!address) return null;
    const flips = new Map();
    for (let i = L + 1; i < chat.length; i++) {
        const x = chat[i]?.extra;
        if (x?.worldscrawl_notice_kind === 'toggle') for (const [mi, id] of x.worldscrawl_notice_changes ?? []) if (!flips.has(`${mi}|${id}`)) flips.set(`${mi}|${id}`, !!x.worldscrawl_notice_on);
    }
    const head = chat.slice(0, L + 1);
    const changes = chatChanges(head).map(c => { const k = `${c._msg}|${c.id}`; return flips.has(k) ? { ...c, off: flips.get(k) } : c; });
    return { index: L, address, changes, now: clockAt(L, chat) };
}
/** One-time "what just happened" line when the map changed around the party without narration (expiry, Turn off, Undo). */
async function aftermathNote(chat, loc) {
    if (!patchSig() && !chat.some(m => m?.extra?.worldscrawl_notice_kind === 'toggle')) return '';
    const then = narratedView(chat);
    if (!then) return '';
    const r = await api('/aftermath', { method: 'POST', body: JSON.stringify({ then, address: loc.address, ...mapCtx() }) }).catch(() => null);
    return r?.ok ? r.body?.note ?? '' : '';
}
/** A temporary change ran out with the party inside: they go back out the way they came in. */
export const expiredNotice = (to, via) => `[Engine: the passage seals behind you. You're back in ${displayName(to)}${via ? ` (out through the ${via})` : ''}.]`;
/** The narrator's one "you're now in X" note: a resolver move not yet followed by a narrated reply. */
export function relocationNote(chat, loc, who) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.extra?.worldscrawl_notice_kind === 'missing' && m.extra.worldscrawl_notice_expired) return playerAddress(m.extra[LOC_KEY]) === loc?.address ? `Note: the temporary place ${who} was in is gone (its time ran out); the passage sealed behind ${who}, and ${who} is back in ${displayName(loc)}. Narrate this naturally.` : '';
        if (m?.extra?.worldscrawl_notice_kind === 'missing') return playerAddress(m.extra[LOC_KEY]) === loc?.address ? `Note: the place ${who} was in no longer exists in this world. ${who} is now in ${displayName(loc)}. Narrate this naturally as where ${who} finds themself now.` : '';
        if (m && !m.is_system && !m.is_user) return '';
    }
    return '';
}

/** Every chat gets a location from turn one: stamp the start onto the greeting (message 0) if nothing is saved. */
export async function ensureStartStamp() {
    syncWorld();
    const c = ctx();
    const first = c.chat?.[0];
    if (!first || getStoredLocation()) return;
    if (!chatWorld()) { // new chat: built on the world chosen in the settings (default: the server's default world)
        const list = await api('/worlds').catch(() => null);
        rememberWorlds(list?.body);
        const id = settings().world || list?.body?.default;
        const info = list?.body?.worlds?.find(w => w.id === id);
        let seed = null;
        if (info?.has_knowledge) seed = (await api(`/worlds/${encodeURIComponent(info.id)}/knowledge`).catch(() => null))?.body?.knowledge ?? null;
        if (info) { first.extra = first.extra ?? {}; first.extra[WORLD_KEY] = { id: info.id, name: info.name, version: info.map_version, ...(seed ? { seed } : {}) };
            for (const sw of first.swipe_info ?? []) { if (sw) { sw.extra = sw.extra ?? {}; sw.extra[WORLD_KEY] = first.extra[WORLD_KEY]; } } }
        syncWorld();
    }
    const seedLoc = worldSeed()?.location;
    const start = (seedLoc && await fetchLocationCached(seedLoc)) || await fetchLocationCached(null);
    if (!start || c.chat?.[0] !== first || getStoredLocation()) return;
    first.extra = first.extra ?? {};
    first.extra[LOC_KEY] = placeStamp(first.extra[LOC_KEY], PLAYER, start.address);
    // keep it on the greeting's swipes too, so swiping the greeting doesn't drop it
    for (const sw of first.swipe_info ?? []) { if (sw) { sw.extra = sw.extra ?? {}; sw.extra[LOC_KEY] = placeStamp(sw.extra[LOC_KEY], PLAYER, start.address); } }
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
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from, direction, ...mapCtx() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return JSON.stringify({ error: d.error ?? `Move failed (${r.status})`, valid_directions: d.valid_directions ?? [] });
    }
    pendingLocation = r.body.address;
    primeCache(r.body);
    return describe(r.body);
}

function stampLocation() {
    if (!isOn()) { pendingLocation = null; return; }
    if (!pendingLocation) return;
    const chat = ctx().chat;
    const msg = chat?.[chat.length - 1];
    if (msg) {
        msg.extra = msg.extra ?? {};
        msg.extra[LOC_KEY] = placeStamp(msg.extra[LOC_KEY], PLAYER, pendingLocation);
    }
    pendingLocation = null;
}

function applyTools() {
    const c = ctx();
    if (!toolsOn() || !isOn()) { TOOL_NAMES.forEach(n => { try { c.unregisterFunctionTool(n); } catch {} }); return; }
    if (!hasPrompts()) { ensurePrompts().then(applyTools).catch(e => console.warn('[WorldScrawl]', e.message)); return; } // ws_wait's description is a prompt
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
    registerFunctionTool({
        name: 'ws_flag',
        displayName: 'WorldScrawl: Flag a map change',
        description: flagToolText(),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { action: { type: 'string', enum: ['change', 'discover', 'wait', 'sleep', 'npc', 'name', 'lore'], description: flagActionText() },
                location: { type: 'string', description: 'The place that changed (its name); for "lore", the place whose lore you want.' }, note: { type: 'string', description: 'For "change": a few words on what changed, e.g. "the inn burned down". For "wait"/"sleep": how long, e.g. "2h", "1h30m", "until morning", "until 14:00".' } },
            required: ['note'],
        },
        action: async ({ action = 'change', location = '', note = '' } = {}) => {
            if (action === 'wait' || action === 'sleep') {
                const w = await planWait(String(note ?? ''), action === 'sleep');
                if (w.error) return `Could not pass time: ${w.error}`;
                if (!(w.seconds >= MIN_NARRATOR_WAIT)) return 'Under 15 minutes: no time is added to the clock.'; pendingWait = w; return `Time passes: ${w.label}. It will then be ${w.afterText}.${waitAsk()}`;
            }
            if (action === 'lore') {
                const loc = await currentLocation(), chain = loc?.lore_chain ?? [];
                const hits = loreFor(chain, String(location || note || ''));
                const asked = String(location || note || '').trim();
                const person = !hits.length && asked ? npcForName([...(framesOf(ctx().chat ?? [], (ctx().chat ?? []).length - 1, castPack()?.npcs ?? []).at(-1)?.values() ?? [])], asked) : null;
                if (person?.deep?.history) { pendingLoreFlags.push(asked); return `${person.name}'s history: ${person.deep.history}`; }
                if (!hits.length) return chain.length ? `No lore on file for that. Lore on file: ${chain.map(c => c.name).join(', ')}.` : 'No lore on file here.';
                pendingLoreFlags.push(...hits.map(h => h.name));
                return renderTokens(P('narration.lore_block', { lore: hits.map(c => `- ${c.name}: ${c.text}`).join('\n') }));
            }
            if (action === 'name') { const n = String(note || location || '').trim().slice(0, 60); if (n) pendingNameFlags.push(n); return 'Noted.'; }
            if (action === 'npc') { const n = String(note || location || '').trim().slice(0, 60); if (n) pendingNpcFlags.push(n); return 'Noted.'; }
            if (action === 'discover') { pendingFlag = { kind: 'discover', hint: String(location ?? ''), note: String(note ?? '').slice(0, 200), source: 'tool' }; return 'Noted. The engine will add the room behind that door after your reply.'; }
            pendingFlag = { hint: String(location ?? ''), note: String(note ?? '').slice(0, 200), source: 'tool' }; return 'Noted. The engine will review the map change after your reply.'; },
        formatMessage: ({ action } = {}) => action === 'wait' || action === 'sleep' ? 'Passing time...' : 'Noting a map change...',
    });
    registerFunctionTool({
        name: 'ws_wait',
        displayName: 'WorldScrawl: Wait or sleep',
        description: P('narration.wait_tool'),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { duration: { type: 'string', description: 'How long, e.g. "2h", "1h30m", "2d".' },
                until: { type: 'string', description: 'Instead of a duration: wait until dawn, morning, noon, dusk, evening, night, midnight, or a time like "14:00".' },
                sleep: { type: 'boolean', description: 'true if they sleep (default 8h when no duration or until is given).' } },
            required: [],
        },
        action: async ({ duration = '', until = '', sleep = false } = {}) => {
            const w = await planWait(waitArgs({ duration, until }), sleep === true || sleep === 'true');
            if (w.error) return `Could not pass time: ${w.error}`;
            if (!(w.seconds >= MIN_NARRATOR_WAIT)) return 'Under 15 minutes: no time is added to the clock.'; pendingWait = w; return `Time passes: ${w.label}. It is now ${w.afterText}.${waitAsk()}`;
        },
        formatMessage: ({ sleep } = {}) => (sleep ? 'Sleeping...' : 'Waiting...'),
    });
    registerFunctionTool({
        name: 'ws_npc',
        displayName: 'WorldScrawl: A person here',
        description: P('narration.npc_tool'),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#', type: 'object',
            properties: {
                action: { type: 'string', description: 'fact, memory, disposition, leave, staying, follow, stay, seek, or detail.' },
                id: { type: 'string', description: 'The person\'s id from the people-here list.' },
                text: { type: 'string', description: 'The fact, memory note, or what detail is needed.' },
                value: { type: 'string', description: 'For disposition: hostile, unfriendly, indifferent, friendly, or helpful.' },
                reason: { type: 'string', description: 'For disposition: why it changed.' },
            },
            required: ['action', 'id'],
        },
        action: async (args = {}) => {
            if (String(args.action ?? '').toLowerCase() === 'detail') return npcDetail(String(args.id ?? ''));
            const stamp = toolNpcStamp(args);
            if (!stamp) return 'Nothing to record.';
            pendingNpc.push(stamp);
            return 'Noted. It will be kept on this reply.';
        },
        formatMessage: () => 'Noting a person...',
    });
}

/** Short system note at depth 1 so the model actually uses the tools (they are ignored without it on many models). */
function applyNudge() {
    const text = toolsOn() && isOn() ? String(settings().nudge ?? '').trim() : '';
    ctx().setExtensionPrompt(NUDGE_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    if (!hasPrompts()) { ensurePrompts().catch(e => console.warn('[WorldScrawl]', e.message)); return; }
    ctx().setExtensionPrompt(FLAGHINT_KEY, !toolsOn() && isOn() && settings().flagTags ? `${flagHint()}\n${waitHint()}` : '', 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

// ---- Engine-driven movement. The engine moves the party; the model never touches the map.
let engineBusy = false;
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
/**
 * The one place that decides whether an exit reveals where it leads. Later a hidden/obscured exit
 * (e.g. exit.hidden or exit.obscured in the region file) can return false here.
 */
export const revealsDestination = exit => !(exit?.hidden || exit?.obscured) || !!exit?.revealed;

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

/** Places stood in during this chat: the start plus every location (and route step) saved on its messages. */
async function stoodInAddresses() {
    await syncDoors();
    const saved = chatAddresses();
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
        const rv = m?.extra?.[REVEAL_KEY]; // /ws-reveal: places marked as been-there (unless turned off)
        if (rv && rv.off !== true) for (const a of rv.addresses ?? []) add(a);
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
 * {{party}} and its alias {{who}}: the names of the party. Today the group is only the player, so this is whoMoves()
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

async function goTarget(t) {
    const c = ctx();
    if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; }
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
        const who = partyText();
        const note = moveNote(who, res.move, exit ?? here.exits.find(e => e.direction.toLowerCase() === String(res.move.direction ?? '').toLowerCase()));
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stamp(msg, res.to, res.move);
        msg.extra.worldscrawl_engine = true; // no intent question for this message
        await c.saveChat();
        renderAllExits();
        await narrate(c);
        return '';
    } catch (e) {
        toastr.error(e.message); return e.message;
    } finally {
        engineBusy = false;
    }
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

// ---- Narrative digging: "I smash a hole in the wall". Small sequential questions, each validated and retried alone.
/** The shared base reply line ({{reply}}) that every system prompt ends with: one, json or text. */
export const baseReply = kind => P(`pick.base_${kind}`);
export const digSys = () => P('dig.system', { reply: baseReply('json') });
export const DIG_TRIES = 2;
export const pickSys = () => P('pick.system', { reply: baseReply('one') });
export const COMPASS = ['north', 'south', 'east', 'west', 'up', 'down'];
// ---- Model-call notes: every model call the extension makes leaves an outcome on the message it belongs to
// (by default the latest message, the one being handled). Saved soon after, so they survive a reload.
let noteSave = null;
function noteCall(at, note) {
    try {
        const c = ctx(), chat = c.chat ?? [], i = Number.isInteger(at) && at >= 0 ? at : chat.length - 1;
        if (!chat[i] || !addCallNote(chat[i], note)) return;
        clearTimeout(noteSave); noteSave = setTimeout(() => { try { ctx().saveChat?.(); } catch { /* ignore */ } }, 1500);
    } catch { /* never break a turn over a debug note */ }
}
const markLast = (at, kind, status, reason) => { try { const chat = ctx().chat ?? []; markCall(chat[Number.isInteger(at) && at >= 0 ? at : chat.length - 1], kind, status, reason); } catch { /* ignore */ } };
/** One model side call, noted: ok with a short answer, or failed (error or empty answer). retry merges with the last note of that kind. */
async function gen(kind, args, { at, retry = false } = {}) {
    try {
        const raw = await ctx().generateRaw(args);
        noteCall(at, String(raw ?? '').trim() ? { kind, status: 'ok', answer: raw, retry } : { kind, status: 'failed', reason: 'empty answer', retry });
        return raw;
    } catch (e) { noteCall(at, { kind, status: 'failed', reason: e?.message ?? String(e), retry }); throw e; }
}
/** Ask one pick-one question; one retry if the answer matches nothing. */
async function askValid(label, prompt, validate, systemPrompt = pickSys()) {
    for (let i = 0; i < DIG_TRIES; i++) {
        const a = await gen(`pick: ${label}`, { prompt, systemPrompt, responseLength: 60 }, { retry: i > 0 });
        const v = validate(trimAnswer(cleanAnswer(a)));
        if (v == null) markLast(undefined, `pick: ${label}`, 'failed', 'answer matched no option');
        console.log(`[WorldScrawl] dig ${label} (try ${i + 1}): ${JSON.stringify(String(a).slice(0, 80))} -> ${v == null ? 'invalid' : JSON.stringify(v)}`);
        if (v != null) return v;
    }
    return null;
}
/** Rooms near `loc` over the map (any exit, hidden too; name/area/first sentence only), nearest first. */
async function nearbyRooms(loc) {
    const r = await api('/nearby', { method: 'POST', body: JSON.stringify({ from: loc.address, depth: 3, limit: 12, ...mapCtx() }) });
    return r.ok ? r.body.rooms : [];
}
// ---- Duplicate-room guard: a "new" place that closely matches a place within about 3 steps is that place.
const dupWords = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !['the', 'a', 'an', 'of'].includes(w)).map(w => w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
const edit1 = (a, b) => { // at most one insert, delete or substitution
    if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
};
/** Do two place names mean the same place? Same words (any order, "the"/plurals ignored), or one typo in one long word. */
export function closeName(a, b) {
    const x = dupWords(a), y = dupWords(b);
    if (!x.length || x.length !== y.length) return false;
    const xs = [...x].sort(), ys = [...y].sort();
    if (xs.join(' ') === ys.join(' ')) return true;
    const diff = x.map((w, i) => [w, y[i]]).filter(([u, v]) => u !== v);
    return diff.length === 1 && diff[0][0].length >= 5 && diff[0][1].length >= 5 && edit1(diff[0][0], diff[0][1]);
}
/** The nearest of `rooms` (from /nearby: {address, name, steps}) whose name closely matches `name`, within maxSteps; null if none. */
export function duplicatePlace(name, rooms, { maxSteps = 3, not = [] } = {}) {
    const hits = (rooms ?? []).filter(r => r?.name && !not.includes(r.address) && (r.steps ?? 0) <= maxSteps && closeName(name, r.name));
    return hits.sort((a, b) => (a.steps ?? 9) - (b.steps ?? 9))[0] ?? null;
}
/**
 * A change's create_place ops whose new room duplicates a nearby place become door pairs to that place instead
 * (one add_exit per exit of the new room; "new:<ref>" pointers to it then name the existing place).
 * Returns {ops, merged: [{name, to, to_name, steps}]}; ops unchanged when nothing matched.
 */
export function mergeDuplicates(ops, rooms, opts = {}) {
    const merged = [], refs = {};
    let out = [];
    for (const o of ops ?? []) {
        const dup = o?.op === 'create_place' && Array.isArray(o.exits) && o.exits.length ? duplicatePlace(o.name, rooms, opts) : null;
        if (!dup || o.exits.some(x => x.to === dup.address)) { out.push(o); continue; }
        merged.push({ name: o.name, to: dup.address, to_name: dup.name, steps: dup.steps });
        if (o.ref) refs[`new:${o.ref}`] = dup.address;
        for (const x of o.exits) out.push({ op: 'add_exit', loc: dup.address, to: x.to, direction: x.direction, return_direction: x.return_direction,
            ...(x.door != null ? { door: x.door } : {}), ...(x.travel_time ? { travel_time: x.travel_time } : {}), ...(x.description ? { description: x.description } : {}), ...(x.return_description ? { return_description: x.return_description } : {}) });
    }
    if (Object.keys(refs).length) out = JSON.parse(JSON.stringify(out), (k, v) => typeof v === 'string' && refs[v] ? refs[v] : v);
    return { ops: merged.length ? out : ops, merged };
}
export const NEW_PLACE = 'new';
/** The places a new opening can lead to: nearby rooms keyed by name (`new` is never a place key). */
export const digOptions = rooms => roomOptions(rooms, new Set([NEW_PLACE]));
export function digPrompt(loc, said, opts, used, canNew, err = '') {
    return P('dig.question', { party: partyText(), place: displayName(loc), description: loc.description ?? '', said,
        places: optionLines(opts) || '- (none)', new_place: canNew ? P('dig.new', { style: P('dig.style') }) + '\n' : '', used: used.join(', ') || 'none',
        retry: err ? P('dig.retry', { error: err }) + '\n' : '' });
}
const digWord = v => String(v ?? '').trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
const okWord = d => /^[a-z][a-z'-]*( [a-z][a-z'-]*)?$/.test(d) && d.length <= 20;
/**
 * Check one breaking-through JSON answer. Returns {ok:true, dest:{room}|{name, description}, direction, back, stay}
 * or {ok:false, error} (the error goes back to the model on the retry).
 */
export function readDigAnswer(a, { loc, opts, canNew, target = null }) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'the answer was not a JSON object' };
    let dest;
    if (a.existing != null && a.existing !== '') {
        const k = matchKey(String(a.existing), opts.map(o => o.key));
        if (k == null) return { ok: false, error: `"existing" must be one of the place keys: ${opts.map(o => o.key).join(', ') || '(none)'}` };
        dest = { room: opts.find(o => o.key === k).room };
    } else if (a.new && typeof a.new === 'object') {
        if (!canNew) return { ok: false, error: 'no new place can be made here: pick an "existing" place key' };
        const name = String(a.new.name ?? '').trim().replace(/\s+/g, ' '), description = String(a.new.description ?? '').trim().replace(/\s+/g, ' ');
        if (!/^[A-Za-z][A-Za-z' -]*$/.test(name) || name.split(' ').length > 5 || name.length > 40 || sameName(name, loc.name)) return { ok: false, error: '"new.name" must be a short new name (2-3 words, letters only)' };
        if (description.length < 10 || description.length > 300) return { ok: false, error: '"new.description" must be one short sentence' };
        dest = { name: name.replace(/\b[a-z]/g, c => c.toUpperCase()), description: /[.!?]$/.test(description) ? description : description + '.' };
    } else return { ok: false, error: canNew ? 'give "existing" (a place key) or "new" ({"name", "description"})' : 'give "existing" (a place key)' };
    const direction = digWord(a.direction);
    if (!okWord(direction)) return { ok: false, error: '"direction" must be a short exit name (1-2 words)' };
    if (hasExit(loc, direction)) return { ok: false, error: `there is already an exit "${direction}" here` };
    const back = digWord(a.return_direction) || returnName(direction);
    if (!okWord(back)) return { ok: false, error: '"return_direction" must be a short exit name (1-2 words)' };
    let backName = back;
    if (target && hasExit(target, backName)) { // e.g. "in" when the courtyard already has an "in": pick a free name instead of failing
        backName = [direction, `broken ${direction}`.slice(0, 20), 'hole', 'breach', 'gap'].find(n => okWord(n) && !hasExit(target, n));
        if (!backName) return { ok: false, error: `${roomLabel(target)} already has an exit "${back}"` };
    }
    const stay = matchKey(String(a.then ?? ''), ['stay', 'go_through']) === 'stay'; // biased toward moving: only a clear "stay" stays
    return { ok: true, dest, direction, back: backName, stay };
}
const nameRe = n => new RegExp(`(^|[^a-z])(?:the\\s+)?${String(n).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![a-z])`, 'i');
/** The nearby place the player's own words name ("...a passage to the courtyard"): the longest name, then the nearest. Null if none. */
export function namedPlace(text, opts) {
    const t = String(text ?? '');
    const hits = opts.filter(o => o.room?.name && nameRe(o.room.name).test(t));
    hits.sort((a, b) => b.room.name.length - a.room.name.length || (a.room.steps ?? 9) - (b.room.steps ?? 9));
    return hits[0] ?? null;
}
/** The exit word the player's text suggests for an opening they named a place for. */
export const digWordFrom = text => (String(text ?? '').match(/\b(window|hole|trapdoor|hatch|skylight|wall|floor|ceiling|crack|breach)\b/i)?.[1].toLowerCase() ?? 'opening');
/** Make the opening: an existing place gets the linked exit pair (a 'dig' change); a new one the shared create_place edit (a 'patch' change). */
async function makeDig(loc, r) {
    const desc = 'A freshly broken opening.';
    if (r.dest.room) {
        const b = await buildDig(loc, r.direction, { address: r.dest.room.address }, { returnDirection: r.back, description: desc, returnDescription: desc });
        return b.ok ? { ok: true, change: b.change, to: b.to, label: b.label } : { ok: false, error: b.error };
    }
    const pl = await loadPatchLib();
    if (!pl) return { ok: false, error: 'the map editor library is unavailable' };
    const op = pl.discoverToCreate({ loc: loc.address, name: r.dest.name, description: r.dest.description, direction: r.direction, return_direction: r.back, door: false, exit_description: desc, return_description: desc, travel_time: '10s' });
    const p = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: [op] }, ...mapCtx() }) });
    if (!p.ok) return { ok: false, error: p.body?.detail?.error ?? JSON.stringify(p.body?.detail ?? p.status) };
    const to = (p.body.touched ?? []).find(a => a.includes('/') && a !== loc.address);
    const change = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: `Broke through ${r.direction} to ${r.dest.name}`, at: chatElapsed(), ops: p.body.ops ?? [op] };
    return { ok: true, change, to, label: p.body.after?.[to]?.name ?? r.dest.name };
}
/**
 * The 'new opening' intent: ONE JSON question (where it leads: a nearby place or, where rooms may be added, a new one;
 * the exit names on both sides; stay or go through), retried once with the error. The change is stamped on the player's message.
 */
async function narrativeDig(msg, loc) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const fail = why => { console.log(`[WorldScrawl] dig failed: ${why}`); noteCall(ctx().chat?.indexOf(msg) ?? -1, { kind: 'breaking through', status: 'failed', reason: why }); msg.extra.worldscrawl_dig_failed = true; return { kind: 'dig_failed', loc }; };
    const opts = digOptions((await nearbyRooms(loc)).filter(r => r.address !== loc.address));
    const named = namedPlace(msg.mes, opts);
    if (named) { opts.splice(opts.indexOf(named), 1); opts.unshift(named); } // the place the player named comes first...
    const canNew = loc.expandable !== false && !named; // ...and is used: never a new place when the player named an existing one
    if (!opts.length && !canNew) return fail('nowhere to lead');
    const saidAll = named ? `${said}\nThe player names ${named.room.name}: the opening leads there (key "${named.key}").` : said;
    const used = loc.exits.filter(e => !e.hidden || e.revealed).map(e => e.direction); // never name a hidden exit in a prompt
    let err = '', made = null, r = null;
    for (let i = 0; i < DIG_TRIES && !made; i++) {
        const raw = await gen('discovery / dig', { prompt: digPrompt(loc, saidAll, opts, used, canNew, err), systemPrompt: digSys(), responseLength: 300 }, { retry: i > 0 });
        const a = parseJsonAnswer(raw);
        let pre = readDigAnswer(a, { loc, opts, canNew });
        const dupe = pre.ok && pre.dest.name ? opts.find(o => o.room && duplicatePlace(pre.dest.name, [o.room])) : null;
        if (dupe) { console.log(`[WorldScrawl] dig: "${pre.dest.name}" is ${dupe.room.name}, already on the map: linking it`); pre = readDigAnswer({ ...a, new: undefined, existing: dupe.key }, { loc, opts, canNew }); }
        const target = pre.ok && pre.dest.room ? await fetchLocationCached(pre.dest.room.address) : null;
        r = pre.ok && pre.dest.room ? (target ? readDigAnswer(a, { loc, opts, canNew, target }) : { ok: false, error: 'that place is unknown' }) : pre;
        if (r.ok) { const m = await makeDig(loc, r); if (m.ok) made = m; else r = { ok: false, error: m.error }; }
        console.log(`[WorldScrawl] dig (try ${i + 1}): ${JSON.stringify(String(raw).slice(0, 120))} -> ${r.ok ? JSON.stringify({ to: made.to, direction: r.direction, back: r.back, stay: r.stay }) : r.error}`);
        if (!made) { err = r.error; markLast(undefined, 'discovery / dig', 'failed', r.error); }
    }
    if (!made && named && !hasExit(loc, digWordFrom(msg.mes))) { // the model's answers didn't fit, but the player said where: link it directly
        const target = await fetchLocationCached(named.room.address);
        if (target) {
            const fb = readDigAnswer({ existing: named.key, direction: digWordFrom(msg.mes), then: 'go_through' }, { loc, opts, canNew: false, target });
            if (fb.ok) { const m = await makeDig(loc, fb); if (m.ok) { made = m; r = fb; console.log(`[WorldScrawl] dig: linked the named place ${named.room.address} directly`); } }
        }
    }
    if (!made) return fail(err);
    msg.extra[CHANGE_KEY] = made.change; // on the player's message, like a move: swipes keep it, deleting the message undoes it
    msg.extra.worldscrawl_dig = { direction: r.direction, back: r.back, to: made.to, to_name: made.label };
    if (r.stay) return { kind: 'dig', loc };
    const res = await engineMove(r.direction); // the change is already on this message, so /move gets it via chatChanges()
    if (!res.ok) { console.warn(`[WorldScrawl] dig: moving through ${r.direction} failed: ${res.error}`); return { kind: 'dig', loc }; }
    stamp(msg, res.to, res.move); // dig first, then location = destination (both roll back with this message)
    return { kind: 'move', loc: res.to };
}
// ---- Looking and doors (the party never moves).
export const LOOK = 'look', OPEN_DOOR = 'open a door', CLOSE_DOOR = 'close a door', NEW_DOOR = 'try another door';
export { LOOK_RE, MOVE_RE, lookOnly, stayPutLine };
export const DOOR_OPEN_RE = /\b(?:open|opens|opened|opening|unlatch\w*|unbar\w*)\b/i;
export const DOOR_CLOSE_RE = /\b(?:close|closes|closed|closing|shut|shuts|shutting|slam|slams|slammed|slamming)\b/i;
export const NO_EXIT = 'out a window or opening with no exit';
const exitTargetLabel = e => `the ${e.direction} exit${revealsDestination(e) ? ` (to ${destLabel(e)})` : ''}`;
export const AROUND = 'around here in general, nothing specific';
export const WINDOW_WORD_RE = /\b(?:windows?|shutters?|outside|outdoors|openings?|balcon(?:y|ies)|portholes?|skylights?)\b/i;
/** Offer the window option only when the player mentions one, or the room already has a view. */
export const offerWindow = (loc, text) => WINDOW_WORD_RE.test(String(text ?? '')) || (loc.views ?? []).length > 0;
/** Options: `around`, then one key per exit, then (maybe) `window`, last. */
export function lookOptions(exits, withWindow = true) {
    const taken = new Set(['around', 'window']);
    return [{ key: 'around', label: AROUND }, ...exits.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), exit: e })), ...(withWindow ? [{ key: 'window', label: NO_EXIT }] : [])];
}
export function lookTargetPrompt(loc, said, exits, withWindow = true) {
    return P('look.target', { party: partyText(), place: displayName(loc), said, options: optionLines(lookOptions(exits, withWindow)) });
}
export const DOOR_LOOK = ['listen', 'peek', 'open', 'look'];
export const closedDoorPrompt = (said, e) => P('look.closed_door', { said, direction: e.direction });
/** One option per nearby room, keyed by its name. */
/** Short keys from the place name; the area is added only when two nearby places share a name. */
export const roomOptions = (rooms, taken = new Set()) => {
    const n = {}; for (const r of rooms) { const k = normKey(r.name ?? r.display_name); n[k] = (n[k] ?? 0) + 1; }
    return rooms.map(r => ({ key: keyFor(n[normKey(r.name ?? r.display_name)] > 1 ? r.display_name : (r.name ?? r.display_name), taken), label: `${r.display_name}: ${r.summary}`, room: r }));
};
export function viewPickPrompt(loc, said, rooms) {
    return P('look.view', { party: partyText(), place: displayName(loc), description: loc.description ?? '', said, places: optionLines(roomOptions(rooms)) });
}
/** The 'look' intent: pick an exit (or a window), then see / hear / nothing. Stamps door and view-link changes on the message. */
async function narrativeLook(msg, loc, forced = null, forcedAct = null) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exits = loc.exits.filter(e => !e.hidden || revealsDestination(e)); // an unrevealed hidden exit is never named
    const stampChange = c => { msg.extra[CHANGE_KEY] = [...changesOf(msg), c]; };
    let look;
    if (!forced && LOOK_AROUND_RE.test(String(msg.mes ?? ''))) look = { kind: 'around' }; // 'I look around': no question, no view link
    const win = !look && offerWindow(loc, msg.mes);
    const pick = look ? null : forced ?? await askValid('look target', lookTargetPrompt(loc, said, exits, win), pickKey(lookOptions(exits, win)));
    if (look) { /* around */ }
    else if (pick == null) look = { kind: 'nothing' };
    else if (pick.key === 'around') look = { kind: 'around' };
    else if (pick.exit) {
        const e = pick.exit;
        const open = doorOverrides();
        let v = viewOf(e, open), opened = false, through = false, stuck = false;
        if (v === 'closed' && sightOf(e, open) !== 'none') { v = 'open'; through = true; } // a closed gate/grate: seen through as it is
        else if (v === 'closed') {
            const act = forcedAct ?? await askValid('closed door', closedDoorPrompt(said, e), a => matchKey(a, DOOR_LOOK)) ?? 'look'; // unreadable: just looking (never opens a door by accident)
            if (act === 'listen') v = 'listen';
            else if (act === 'open' && isStuck(e, open)) { v = 'shut'; stuck = true; }
            else if (act === 'open') { openChanges(loc, e).forEach(stampChange); opened = true; v = 'open'; }
            else if (act === 'peek' && barrierOf(e).openable === false) v = 'shut'; // rubble: no crack to peek through
            else if (act === 'peek') { msg.extra.worldscrawl_peek = { type: 'peek', door: e.direction, from: loc.address }; v = 'peek'; } // no effect on door state (for a later stealth mechanic)
            else v = 'shut';
        }
        const t = (v === 'open' || v === 'peek') && revealsDestination(e) && e.to ? await fetchLocationCached(e.to) : null;
        const lvl = sightOf(e, opened ? new Map([[e.door, { type: 'open_door' }]]) : open);
        look = v === 'listen' ? { kind: 'listen', via: e.direction, sound: soundOf(e, open), word: barrierWord(e) }
            : v === 'shut' && !stuck && e.description && !revealsDestination(e) ? { kind: 'threshold', via: e.direction, description: e.description, shut: true, unknown: !revealsDestination(e) }
            : v === 'shut' ? { kind: 'closed', via: e.direction, word: barrierWord(e), ...(stuck ? { stuck: stuckWhy(e) } : {}) }
            : t ? { kind: 'see', via: e.direction, to: t.address, name: displayName(t), description: t.description, opened, ...(v === 'peek' ? { peek: true } : { sight: lvl }), ...(through ? { through_closed: true } : {}) }
            : e.description && v !== 'shut' ? { kind: 'threshold', via: e.direction, description: e.description, opened, ...(through ? { through_closed: true } : {}), ...(v === 'peek' ? { peek: true } : {}), unknown: !revealsDestination(e), ...(revealsDestination(e) && (e.to_label ?? e.to_name) ? { name: e.to_label ?? e.to_name } : {}) }
            : { kind: 'nothing', via: e.direction, opened };
    } else {
        let view = (loc.views ?? [])[0]; // hand-written views first, then an earlier view link: the same answer every time
        if (!view) {
            const rooms = await nearbyRooms(loc);
            const k = rooms.length ? await askValid('view', viewPickPrompt(loc, said, rooms), pickKey(roomOptions(rooms))) : null;
            if (k != null) { view = k.room; stampChange({ type: 'view_link', from: loc.address, to: view.address }); }
        }
        const t = view ? await fetchLocationCached(view.address) : null;
        look = t ? { kind: 'see', window: true, to: t.address, name: displayName(t), description: t.description } : { kind: 'nothing', window: true };
    }
    if (!changesOf(msg).length) delete msg.extra[CHANGE_KEY];
    msg.extra.worldscrawl_look = look;
    console.log(`[WorldScrawl] look: ${JSON.stringify(look).slice(0, 160)}`);
    return { kind: 'look', loc };
}
export const doorOptions = list => { const taken = new Set(); return list.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), exit: e })); };
export const doorPickPrompt = (loc, said, list, type) => P('door.pick', { party: partyText(), place: displayName(loc), said, verb: type === 'open_door' ? 'open' : 'close', options: optionLines(doorOptions(list)) });
/** The open/close door intents: which door (asked only if several), stamped on the message. */
async function narrativeDoor(msg, loc, list, type) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    let e = list.length === 1 ? list[0] : null;
    if (!e) {
        e = (await askValid('door', doorPickPrompt(loc, said, list, type), pickKey(doorOptions(list))))?.exit ?? null;
    }
    if (!e) return { kind: STAY, loc };
    if (type === 'open_door' && isStuck(e)) { msg.extra.worldscrawl_door = { type: 'stuck', direction: e.direction, why: stuckWhy(e) }; return { kind: 'door', loc }; }
    msg.extra[CHANGE_KEY] = [...changesOf(msg), ...(type === 'open_door' ? openChanges(loc, e) : [doorChange(type, loc, e)])];
    msg.extra.worldscrawl_door = { type, direction: e.direction };
    return { kind: 'door', loc };
}
export const DIG_FAILED_NOTICE = 'Nothing gave way: no new opening was made.';

export const travelSys = () => P('travel.system');
export const travelYesNoPrompt = (loc, said) => P('travel.question', { party: partyText(), place: loc.name, said });
export const intentSys = () => P('intent.system', { reply: baseReply('one') });

/**
 * Ask the model one multiple-choice question about the player's message.
 * Returns {kind:'move'|'stay'|'elsewhere', loc}. An unreadable answer gets a yes/no follow-up
 * ("trying to travel?"): a clear yes is 'elsewhere', anything else is 'stay'.
 */
export function intentPrompt({ loc, exitLines, said, moveDirs, movePlaces, canOpen, canLook, canOpenDoor, canCloseDoor, canNewDoor, onlyLook, options }) {
    const opt = (id, option) => P(`intent.option.${id}`, { option }) + '\n';
    const lines = moveDirs.map(d => P('intent.option.exit', { direction: d }) + '\n').join('')
        + movePlaces.map(p => P('intent.option.place', { label: p.label }) + '\n').join('')
        + (canOpen ? opt('new_opening', OPEN) : '') + (canLook ? opt('look', LOOK) : '') + (canOpenDoor ? opt('open_door', OPEN_DOOR) : '')
        + (canCloseDoor ? opt('close_door', CLOSE_DOOR) : '') + (canNewDoor ? opt('new_door', NEW_DOOR) : '') + opt('stay', STAY)
        + (onlyLook ? '\n' : opt('elsewhere', ELSEWHERE) + opt('unclear', UNCLEAR) + '\n');
    return P('intent.question', { party: partyText(), place: displayName(loc), exits: exitLines.join('\n') || '- (none)', said, option_lines: lines, options: options.join(', ') });
}
async function parseIntent(msg) {
    await ensurePrompts();
    const c = ctx();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    const loc = await currentLocation();
    const dirs = loc.exits.map(e => e.direction);
    const places = await discoveredTargets(loc);
    const prev = previousAddress(loc.address);
    const canOpen = BREAK_RE.test(msg.mes ?? ''); // the 'new opening' choice is only offered when the player uses a breaking-through word
    const canLook = LOOK_RE.test(msg.mes ?? '');
    const doors = doorCandidates(loc);
    doors.toOpen = [...doors.toOpen, ...doors.stuck]; // trying a locked door is still the 'open' intent; it just doesn't give
    const canOpenDoor = DOOR_OPEN_RE.test(msg.mes ?? '') && doors.toOpen.length > 0, canCloseDoor = DOOR_CLOSE_RE.test(msg.mes ?? '') && doors.toClose.length > 0;
    const canNewDoor = DOOR_OPEN_RE.test(msg.mes ?? '') && loc.expandable !== false; // a door not on the map yet: maybe a discovery
    const extras = [...(canOpen ? [OPEN] : []), ...(canLook ? [LOOK] : []), ...(canOpenDoor ? [OPEN_DOOR] : []), ...(canCloseDoor ? [CLOSE_DOOR] : []), ...(canNewDoor ? [NEW_DOOR] : [])];
    // Only looking ("I look out the door"): no move options, so a word like "out" can't pick the "out" exit.
    const onlyLook = canLook && lookOnly(msg.mes);
    const moveDirs = onlyLook ? [] : dirs, movePlaces = onlyLook ? [] : places;
    const options = [...moveDirs, ...movePlaces.map(p => p.label), ...extras, STAY, ...(onlyLook ? [] : [ELSEWHERE, UNCLEAR])];
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exitLines = exitLabels(loc.exits, n => n).map((lbl, i) => {
        const e = loc.exits[i];
        const nm = lbl.length > e.direction.length ? lbl.slice(e.direction.length) : destLabel(e); // same label as the footer: room, or building (+ room / region)
        return `- ${e.direction}${revealsDestination(e) ? ` (to ${nm}${e.to === prev ? ', where you came from' : ''})` : ''}`;
    });
    const prompt = intentPrompt({ loc, exitLines, said, moveDirs, movePlaces, canOpen, canLook, canOpenDoor, canCloseDoor, canNewDoor, onlyLook, options });
    const answer = await gen('intent', { prompt, systemPrompt: intentSys(), responseLength: 48 });
    const cands = await travelCandidates(loc);
    // Without the word check passing, "new opening" is not an option: such an answer falls through to the normal handling.
    let choice = parseIntentAnswer(answer, [...dirs, ...places.map(p => p.label), ...extras]);
    if (choice === OPEN) return await narrativeDig(msg, loc);
    if (choice === LOOK) return await narrativeLook(msg, loc);
    if (choice === NEW_DOOR) { msg.extra.worldscrawl_new_door = true; return { kind: STAY, loc }; }
    if (choice === OPEN_DOOR || choice === CLOSE_DOOR) return await narrativeDoor(msg, loc, choice === OPEN_DOOR ? doors.toOpen : doors.toClose, choice === OPEN_DOOR ? 'open_door' : 'close_door');
    if (onlyLook) { console.log(`[WorldScrawl] look-only message, answer ${JSON.stringify(String(answer).slice(0, 40))} -> stay`); return { kind: 'stay', loc }; }
    const ans = trimAnswer(cleanAnswer(answer));
    const insideAns = !dirs.includes(choice) && hereAreas(loc).find(a => sameName(a.name, choice ?? ans));
    if (insideAns) return { kind: 'already', loc, name: insideAns.name };
    if (!choice) { // a bare name that matches known places (e.g. "Upstairs Rooms")
        const m = matchCandidates(trimAnswer(cleanAnswer(answer)), cands);
        if (m.length > 1) return { kind: 'which', loc, candidates: m };
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
    }
    if (!choice) {
        const yn = await gen('intent: travel yes/no', { prompt: travelYesNoPrompt(loc, said), systemPrompt: travelSys(), responseLength: 48 });
        choice = parseYesNo(yn) === 'yes' ? ELSEWHERE : STAY;
        console.log(`[WorldScrawl] intent fallback: ${JSON.stringify(String(yn).slice(0, 80))} -> ${choice}`);
    }
    console.log(`[WorldScrawl] intent: ${JSON.stringify(String(answer).slice(0, 80))} -> ${choice}`);
    if (dirs.includes(choice)) choice = checkExitChoice(msg.mes, loc.exits.find(e => e.direction === choice), cands) ?? choice;
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
    let place = places.find(p => p.label === choice) ?? (dirs.includes(choice) ? null : cands.find(x => x.label === choice && !x.direction));
    if (place && !place.area) {
        // The player named a building ("go to the Drowned Rat") but the model picked one of its rooms (often the
        // entrance). Unless the room's own name was said, go to the building: its nearest known room.
        const said = new Set(words(msg.mes));
        const area = !keyWords(place.name).some(w => said.has(w))
            && cands.find(x => x.area && x.prefix && place.address.startsWith(x.prefix) && namedInText(msg.mes, [x]).length);
        if (area) { console.log(`[WorldScrawl] building named, model picked a room: ${place.label} -> ${area.label}`); place = area; }
    }
    const nearArea = !dirs.includes(choice) && cands.find(x => x.label === choice && x.area);
    if (nearArea && hereAreas(loc).some(a => sameName(a.name, nearArea.name))) return { kind: 'already', loc, name: nearArea.name };
    const res = place ? await engineTravel(place.address, place.prefix ?? null) : await engineMove(choice);
    if (!res.ok) return { kind: ELSEWHERE, loc, noRoute: place?.label ?? null };
    stamp(msg, res.to, res.move);
    return { kind: 'move', loc: res.to };
}

// ---- Bracket commands: "I [move] north", "I [look] out the window". One verb table for bracket verbs and slash
// commands: a recognised verb skips the intent question; its target is matched exactly from the words after it, with
// one small target-only question if that fails. Unknown bracket words ([OOC: ...], [sic]) are left alone.
export const VERBS = [
    { id: 'move', words: ['move', 'go', 'walk'], slash: '/ws-go <exit or place>', help: 'go through an exit or to a known place, e.g. [move] north' },
    { id: 'travel', words: ['travel'], slash: '/ws-go <place>', help: 'travel to a place you know, e.g. [travel] Village Square' },
    { id: 'look', words: ['look'], slash: null, help: 'look around, at an exit, or out a window, e.g. [look] out the window' },
    { id: 'open', words: ['open'], slash: '/ws-open <exit>', help: 'open a door here, e.g. [open] trapdoor' },
    { id: 'close', words: ['close', 'shut'], slash: '/ws-close <exit>', help: 'close a door here, e.g. [close] door' },
    { id: 'bar', words: ['bar'], slash: '/ws-bar [exit]', help: 'bar a door from the side its bar is on, e.g. [bar] the cellar door' },
    { id: 'unbar', words: ['unbar'], slash: '/ws-unbar [exit]', help: 'lift the bar on a door, e.g. [unbar] door' },
    { id: 'dig', words: ['dig', 'break', 'break through'], slash: '/ws-dig <exit> <place>', help: 'break a new opening, e.g. I [break through] the wall' },
    { id: 'wait', words: ['wait'], slash: '/ws-wait <time>', help: 'let time pass here, e.g. [wait] 2h or [wait] until morning' },
    { id: 'sleep', words: ['sleep'], slash: '/ws-sleep [time]', help: 'sleep here (8h unless you say), e.g. [sleep] until morning' },
    { id: 'lore', words: ['lore'], slash: null, help: 'bring up what locals know about this place (its lore) for the rest of the scene, e.g. [lore] or [lore] The Drowned Rat' },
    { id: 'help', words: ['help'], slash: '/ws-help', help: 'list these commands' },
    { id: 'remember', words: ['remember'], slash: '/ws-npc <name>', help: 'remember a person from the story, e.g. I [remember] Maren' },
];
const VERB_OF = new Map(VERBS.flatMap(v => v.words.map(w => [w, v])));
const TARGET_FILLER = new Set(['to', 'the', 'a', 'an', 'at', 'through', 'into', 'in', 'toward', 'towards', 'out', 'of', 'my', 'way']);
/** The first bracket whose word is a known verb: {verb, target, raw}, or null. "out" stays when it is all there is ("[move] out"). */
export function parseBracket(text) {
    for (const m of String(text ?? '').matchAll(/\[([^\[\]]{1,40})\]([^\[\n.!?,;:]*)/g)) {
        const v = VERB_OF.get(m[1].trim().toLowerCase().replace(/\s+/g, ' '));
        if (!v) continue;
        const words = m[2].trim().split(/\s+/).filter(Boolean);
        let i = 0;
        while (i < words.length - 1 && TARGET_FILLER.has(words[i].toLowerCase())) i++;
        if (words.length === 1 && TARGET_FILLER.has(words[0].toLowerCase()) && !['out', 'in'].includes(words[0].toLowerCase())) i = 1;
        return { verb: v.id, word: m[1].trim(), target: words.slice(i).join(' '), raw: m[0] };
    }
    return null;
}
/** Bracketed verbs read as plain words for the narrator ("I [move] north" -> "I move north"). */
export const unbracket = text => String(text ?? '').replace(/\[([^\[\]]{1,40})\]/g, (all, w) => (VERB_OF.has(w.trim().toLowerCase().replace(/\s+/g, ' ')) ? w.trim() : all));
/** Slash commands with no bracket verb (listed by /ws-help after the verbs). */
export const SLASH_ONLY = [
    ['/ws-change [what changed]', 'the map changed in the latest message (fire, collapse...): work out the change'],
    ['/ws-exits', 'show the exits from here'], ['/ws-known', 'list the places this chat knows'],
    ['/ws-reveal all|region|subregion|<id>|off', 'mark places as visited so you can travel there'],
    ['/ws-removeexit <exit>', 'remove an exit from this room'], ['/ws-map', 'open the map window'],
    ['/ws-save-world <name>', "save this chat's world as a new world"], ['/ws-on, /ws-off', 'turn WorldScrawl on or off in this chat'],
];
export const helpText = () => `WorldScrawl commands. Write a verb in brackets in your message, or use the slash command:\n${VERBS.map(v => `- [${v.words[0]}]${v.slash ? ` (${v.slash})` : ''}: ${v.help}`).join('\n')}\nSlash commands only:\n${SLASH_ONLY.map(([c, h]) => `- ${c}: ${h}`).join('\n')}`;
export const bracketTargetPrompt = (loc, b, opts) => P('intent.bracket_target', { party: partyText(), place: displayName(loc), verb: b.word, target: b.target, options: optionLines(opts) });
/** Exact match first (an exit name, then a place), else one small target-only question; null when nothing fits. */
async function bracketTarget(loc, b, opts) {
    if (!b.target || !opts.length) return null;
    const exact = opts.filter(o => sameName(o.match ?? o.key, b.target) || sameName(o.key, b.target));
    if (exact.length === 1) return exact[0];
    const pick = pickKey(opts);
    return (await askValid('bracket target', bracketTargetPrompt(loc, b, opts), a => (/^none\b/i.test(String(a).trim()) ? false : pick(a)))) || null; // 'none': no retries
}
const failed = (loc, note) => ({ kind: 'bracket_failed', loc, note });
/** Handle one bracket verb on the player's message. Returns a parseIntent-style result. */
export async function bracketIntent(msg, b) {
    await ensurePrompts();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    msg.extra.worldscrawl_bracket = { verb: b.verb, target: b.target };
    const loc = await currentLocation();
    const exitsSeen = loc.exits.filter(e => !e.hidden || revealsDestination(e));
    if (b.verb === 'help') return { kind: 'help', loc };
    if (b.verb === 'remember') { await offerRemember(msg, b.target); return { kind: 'remember', loc }; }
    if (b.verb === 'lore') {
        const chain = loc.lore_chain ?? [];
        if (!chain.length) return failed(loc, `[${b.word}]: no lore on file here.`);
        if (!requestLore(msg, loc, b.target ?? '', 'bracket').length) { msg.extra[LORE_KEY] = (msg.extra[LORE_KEY] ?? []).slice(0, -1); return failed(loc, `[${b.word}] ${b.target}: lore on file here: ${chain.map(c => c.name).join(', ')}.`); }
        return { kind: 'lore', loc };
    }
    if (b.verb === 'move' || b.verb === 'travel') {
        if (!b.target) return failed(loc, `[${b.word}] needs where to: an exit or a place you know.`);
        const taken = new Set(), cands = await travelCandidates(loc);
        const opts = [...(b.verb === 'move' ? exitsSeen.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), match: e.direction, exit: e })) : []),
            ...cands.filter(x => !x.direction).map(x => ({ key: keyFor(x.name ?? x.label, taken), label: x.label, match: x.name ?? x.label, place: x }))];
        const hit = await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, `[${b.word}] ${b.target}: there is no exit or known place called "${b.target}" here.`);
        const res = hit.exit ? await engineMove(hit.exit.direction) : await engineTravel(hit.place.address, hit.place.prefix ?? null);
        if (!res.ok) return failed(loc, `[${b.word}] ${b.target}: ${res.error ?? 'there is no way there from here.'}`);
        stamp(msg, res.to, res.move);
        return { kind: 'move', loc: res.to };
    }
    if (b.verb === 'look') {
        const t = b.target.toLowerCase();
        if (!t || /^(around|about|here|room)$/.test(t)) return await narrativeLook(msg, loc, { key: 'around' });
        if (/\b(window|opening)\b/.test(t) && !exitsSeen.some(e => sameName(e.direction, t))) return await narrativeLook(msg, loc, { key: 'window' });
        const opts = lookOptions(exitsSeen, false).filter(o => o.exit).map(o => ({ ...o, match: o.exit.direction }));
        const hit = await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, `[${b.word}] ${b.target}: there is no "${b.target}" to look at here.`);
        return await narrativeLook(msg, loc, hit, 'look');
    }
    if (b.verb === 'open' || b.verb === 'close') {
        const d = doorCandidates(loc), list = b.verb === 'open' ? [...d.toOpen, ...d.stuck] : d.toClose;
        const opts = doorOptions(list).map(o => ({ ...o, match: o.exit.direction }));
        const hit = list.length === 1 && !b.target ? opts[0] : await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, list.length ? `[${b.word}] ${b.target}: doors you can ${b.verb} here: ${list.map(x => x.direction).join(', ')}.` : `[${b.word}]: no door to ${b.verb} here.`);
        return await narrativeDoor(msg, loc, [hit.exit], b.verb === 'open' ? 'open_door' : 'close_door');
    }
    if (b.verb === 'bar' || b.verb === 'unbar') {
        const bars = exitsSeen.filter(e => e.door && barrierOf(e)?.barred_from), mine = bars.filter(barHere);
        const list = mine.filter(e => (b.verb === 'bar') !== isBarredNow(e));
        const opts = doorOptions(list).map(o => ({ ...o, match: o.exit.direction }));
        const hit = list.length === 1 && !b.target ? opts[0] : await bracketTarget(loc, b, opts);
        if (!hit) {
            const far = b.target && bars.find(e => !barHere(e) && sameName(e.direction, b.target));
            return failed(loc, far ? `[${b.word}] ${b.target}: the bar on that door is on the other side.`
                : list.length ? `[${b.word}] ${b.target}: doors you can ${b.verb} here: ${list.map(x => x.direction).join(', ')}.` : `[${b.word}]: no door to ${b.verb} here${mine.length ? ` (${mine.map(x => x.direction).join(', ')} ${mine.length === 1 ? 'is' : 'are'} already ${b.verb === 'bar' ? 'barred' : 'unbarred'})` : ' with a bar on this side'}.`);
        }
        const e = hit.exit;
        msg.extra[CHANGE_KEY] = [...changesOf(msg), ...(b.verb === 'bar' ? [...(isOpenNow(e) ? [doorChange('close_door', loc, e)] : []), doorChange('bar_door', loc, e)] : [doorChange('unbar_door', loc, e)])];
        msg.extra.worldscrawl_door = { type: `${b.verb}_door`, direction: e.direction };
        return { kind: 'door', loc };
    }
    if (b.verb === 'dig') return await narrativeDig(msg, loc);
    if (b.verb === 'wait' || b.verb === 'sleep') {
        const w = await planWait(b.target, b.verb === 'sleep');
        if (w.error) return failed(loc, `[${b.word}] ${b.target}: ${w.error}.`);
        stampWait(msg, w);
        return { kind: STAY, loc };
    }
    return null;
}

const MENTION_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'into', 'onto', 'in', 'on', 'at', 'by', 'and', 'or', 'with', 'from', 'back', 'behind', 'beside', 'down', 'up', 'out', 'its', 'set', 'leading', 'leads', 'way', 'room', 'rooms']);
/** Does the player's text refer to this exit itself (its word, or a word of its description: "down the stair" -> grate)? */
export function exitMentioned(text, exit) {
    const said = new Set(words(text));
    const own = [...words(exit?.direction), ...words(exit?.description)].filter(w => w.length > 2 && !MENTION_STOP.has(w));
    return words(exit?.direction).some(w => said.has(w)) || own.some(w => [...said].some(t => sameWord(t, w)));
}
/**
 * Second look at an exit the model picked (null = keep it). The model tends to guess an exit for a place it
 * doesn't know ("the secret tunnel" -> the grate). Unless the player referred to the exit itself:
 * an unrevealed hidden/obscured exit is never a guess for a named place (-> elsewhere: the normal notices);
 * a normal exit loses to a single known place the player named that it doesn't lead to.
 */
export function checkExitChoice(text, exit, cands) {
    if (!exit || exitMentioned(text, exit)) return null;
    if (!revealsDestination(exit)) { console.log(`[WorldScrawl] model picked the unrevealed "${exit.direction}" exit, not mentioned by the player -> elsewhere`); return ELSEWHERE; }
    const named = namedInText(text, cands);
    if (named.length !== 1) return null;
    const n = named[0];
    if (n.address === exit.to || n.direction === exit.direction || (n.prefix && String(exit.to).startsWith(n.prefix))) return null;
    console.log(`[WorldScrawl] model picked "${exit.direction}" but the player named ${n.label}`);
    return n.direction ?? n.label;
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
async function addNotice({ loc, noRoute = null, kind = 'unreachable', candidates = [], name = '', prefix = WHICH_PREFIX, text = '' }) {
    const c = ctx();
    const which = kind === 'which';
    const cands = candidates.map(x => ({ label: x.label, name: x.name, ...(x.direction ? { direction: x.direction } : {}), ...(x.prefix ? { prefix: x.prefix } : {}), address: x.address }));
    const msg = {
        name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: kind === 'text' ? text : which ? whichText(cands, prefix) : kind === 'already' ? alreadyText(loc, name) : unreachableText(loc, noRoute),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: kind, worldscrawl_notice_loc: loc?.address ?? null,
            worldscrawl_notice_prefix: kind === 'text' ? '' : which ? prefix : kind === 'already' ? `You're already in ${name}.` : noticePrefix(noRoute), ...(which ? { worldscrawl_notice_candidates: cands } : {}) },
    };
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
}

const PLAIN_DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w', 'up', 'down', 'in', 'out', 'inside', 'outside', 'back', 'forward', 'left', 'right']);
const withArticle = name => (/^(the|a|an)\s/i.test(name) || /^[A-Z][\w-]*'s\s/.test(name) ? name : `the ${name}`);
/**
 * Where exactly the party arrived, room before building, so the model doesn't put them in the building's main room:
 * "arrives in the Stable of The Drowned Rat, entering through the gate (not the Common Room or any other part of
 * The Drowned Rat)". Built only from the room the server returned.
 */
export function arrival(loc, move) {
    const sub = loc.subregion ?? {};
    const room = loc.name;
    const where = sub.name && sub.name !== room && !sub.label_rooms ? `${withArticle(room)} of ${sub.name}` : room;
    const subOf = a => String(a ?? '').split('/')[0];
    const newBuilding = !!move?.from && subOf(move.from) !== subOf(loc.address);
    const dir = move?.last_direction ?? move?.direction;
    let text = `arrives in ${where}`;
    if (newBuilding && dir && !PLAIN_DIRECTIONS.has(String(dir).toLowerCase())) text += `, entering through the ${dir}${move.prev_name ? ` from ${move.prev_name}` : ''}`;
    let not = '';
    if (newBuilding && sub.name && sub.name !== room && sub.entrance && sub.entrance !== loc.address)
        not = ` They are in ${withArticle(room)}, not ${withArticle(sub.entrance_name ?? 'main room')} or any other part of ${sub.name}`;
    return { text: text + (not ? '.' + not : ''), where };
}

/** Short last-line reminder for move/travel turns (empty otherwise). */
export function arrivalReminder(loc, move) {
    if (!move || move.to !== loc.address) return '';
    const where = arrival(loc, move).where;
    return P('narration.arrival_reminder', { where });
}

/** "out", "up", "north"...: a direction, not a thing you can look through. */
export const isDirWord = d => PLAIN_DIRECTIONS.has(String(d ?? '').toLowerCase());
const doorWord = d => (isDirWord(d) ? `door (${d})` : d);
/** One line per thing visible from here: open exits (glimpse of the room beyond) and window views. */
export function glimpseLines(loc, open = new Map()) {
    const out = [];
    for (const e of loc.exits ?? []) {
        if (!revealsDestination(e) || !e.to_summary) continue;
        const sight = sightOf(e, open), sound = soundOf(e, open), closed = !isOpenNow(e, open), name = e.to_label ?? e.to_display_name ?? e.to_name;
        if (sight !== 'none') out.push(`${closed ? `Through the closed ${e.direction}` : isDirWord(e.direction) ? `Looking ${e.direction}` : `Through the ${e.direction}`}, you can see ${name}: ${e.to_summary}${sight === 'clear' ? ' The view is open and carries well beyond it.' : ''}`);
        else if (closed && sound === 'clear') out.push(`Sounds from ${name} carry clearly through the closed ${e.direction}, though nothing can be seen through it.`);
    }
    for (const v of loc.views ?? []) out.push(`Visible from here (no way through): ${v.display_name}: ${v.summary}`);
    return out;
}
export function lookText(who, here, look) {
    const how = look.window ? 'out' : look.via ? (isDirWord(look.via) ? look.via : `through the ${look.via}`) : 'around';
    const first = look.opened ? `${who} opens the ${doorWord(look.via)} first. ` : '';
    if (look.kind === 'see' && look.peek) return `What just happened: ${who} peeks through the closed ${doorWord(look.via)} without opening it and glimpses ${look.name}: ${look.description} The door stays closed. ${who} is still at ${here}. Describe only the glimpse.`;
    if (look.kind === 'see' && look.through_closed) return `What just happened: ${who} looks through the closed ${look.via} (it can be seen through) and sees ${look.name}: ${look.description} It stays closed. ${who} is still at ${here}. Describe only what can be seen from here.`;
    if (look.kind === 'see') return `What just happened: ${first}${who} looks ${how} and sees ${look.name}: ${look.description}${look.sight === 'clear' ? ' The view is open and carries far.' : ''} ${who} does not go there and is still at ${here}. Describe only what can be seen from here.`;
    if (look.kind === 'threshold') return `What just happened: ${first}${who} looks ${look.through_closed ? `through the closed ${look.via}` : look.peek ? `through a gap in the closed ${doorWord(look.via)}` : look.shut ? `at the closed ${doorWord(look.via)}` : how}. All that can be seen is what is right there: ${look.description} ${look.unknown ? 'Where it leads is not clear and is unknown; do not name, describe or guess what lies beyond.' : `${look.name ? `It leads to ${look.name}, but that` : 'Where it leads'} cannot be seen from here; ${look.name ? 'it may be named but' : ''} do not describe what lies at the far end.`} ${who} is still at ${here}.`;
    if (look.kind === 'closed' && look.stuck) return `What just happened: ${who} tries to open the ${doorWord(look.via)}, but it ${look.stuck}. Nothing beyond it can be seen. ${who} stays at ${here}.`;
    if (look.kind === 'closed') return `What just happened: ${who} looks at the ${doorWord(look.via)}. ${look.word === 'way' ? 'The way is blocked' : 'The door is closed'}; nothing beyond it can be seen. ${who} stays at ${here}.`;
    if (look.kind === 'listen' && look.sound === 'clear') return `What just happened: ${who} listens at the closed ${doorWord(look.via)}. Sounds from beyond it carry clearly. ${who} stays at ${here}.`;
    if (look.kind === 'listen' && look.sound === 'none') return `What just happened: ${who} listens at the closed ${doorWord(look.via)}. No sound at all comes through it. ${who} stays at ${here}.`;
    if (look.kind === 'listen') return `What just happened: ${who} listens at the closed ${doorWord(look.via)}. Only faint, muffled sounds come from beyond it; nothing can be made out clearly. ${who} stays at ${here}.`;
    return `What just happened: ${first}${who} looks ${how}, but nothing can be made out beyond it. ${who} stays at ${here}.`;
}
export const LOOK_AROUND_RE = /\b(?:look(?:s|ed|ing)?|glanc(?:e|es|ed|ing)|gaz(?:e|es|ed|ing)|peer(?:s|ed|ing)?)\s+(?:around|about|round)\b|\b(?:survey(?:s|ed|ing)?|take(?:s)? in) (?:the|my|our) surroundings\b/i;
/** The narration line for a door that is not on the map yet: open it (and flag a discovery) only if it fits the room. */
export const newDoorLine = (who, place, tools) => P('narration.new_door', { party: who, place, how_to_flag: P(tools ? 'narration.new_door_tools' : 'narration.new_door_tags') });
export function factsText(loc, move, toolsOn, extra = {}) {
    const who = partyText();
    const lines = [
        P('narration.header'),
        `Current location: ${loc.name}${loc.subregion?.name && loc.subregion.name !== loc.name ? `, ${loc.subregion.name}` : ''}${loc.region?.name ? ` (${loc.region.name})` : ''}`,
        `This location: ${loc.description ?? ''}`,
        extra.lore_index || '',
        extra.lore_fed || '',
        exitsText(loc).replace(/^Exits:/, 'Exits from here:'),
        ...glimpseLines(loc, extra.open),
        extra.date ? `Current time: ${extra.date}.${move?.seconds ? ` (That ${move.path?.length > 2 ? 'journey' : 'move'} took ${extra.took}.)` : ''} Let the time of day show in the narration.` : '',
        extra.weather ? `${extra.weather} Let the weather and temperature show in the narration where it fits; do not change them.` : '',
        (extra.npcs_present || extra.npc_focus) ? P('narration.npcs', { npcs_present: extra.npcs_present || '(none)', npc_focus: extra.npc_focus || '', how_to_report: P(toolsOn ? 'narration.npc_tools' : 'narration.npc_tags') }) : '',
    ];
    const arr = move && move.to === loc.address ? arrival(loc, move) : null;
    const arrivalText = arr ? ` ${who} ${arr.text}.` : '', where = arr?.where ?? move?.to_name, place = displayName(loc);
    if (extra.dig && move && move.to === loc.address) lines.push(P('narration.dig_through', { party: who, direction: extra.dig.direction, from: move.from_name, arrival: arrivalText, where }));
    else if (move?.path?.length > 2) lines.push(P('narration.travel', { party: who, from: move.path[0], via: move.path.slice(1, -1).join(', '), to: move.to_name, cut_short: move.stopped ? P('narration.travel_cut_short') : '', arrival: arrivalText, where }));
    else if (move) lines.push(P('narration.move', { party: who, direction: move.direction, from: move.from_name, to: move.to_name, arrival: arrivalText, where }));
    else if (extra.digFailed && !extra.dig) lines.push(P('narration.dig_failed', { party: who, place })); // a failure outranks any other note on the turn
    else if (extra.look && extra.look.kind !== 'around') lines.push(lookText(who, place, extra.look));
    else if (extra.door?.type === 'stuck') lines.push(P('narration.door_stuck', { party: who, door: doorWord(extra.door.direction), why: extra.door.why, place }));
    else if (extra.newDoor) lines.push(newDoorLine(who, place, toolsOn));
    else if (extra.door) lines.push(P('narration.door', { party: who, verb: ({ open_door: 'opens', close_door: 'closes', bar_door: 'bars', unbar_door: 'unbars' })[extra.door.type] ?? 'closes', door: doorWord(extra.door.direction) + (isDirWord(extra.door.direction) ? '' : ' door'), place }));
    else if (extra.dig) lines.push(P('narration.dig_here', { party: who, direction: extra.dig.direction, to: extra.dig.to_name, place }));
    else if (extra.lookAround || extra.look?.kind === 'around') lines.push(P('narration.look_around', { party: who, place }));
    else lines.push(stayPutLine(who, displayName(loc)));
    if (!move && lines.at(-1) !== stayPutLine(who, displayName(loc))) lines.push(stayPutLine(who, displayName(loc)));
    if (move?.traversal?.length && move.to === loc.address) lines.push(P('narration.on_the_way', { steps: move.traversal.join(' Then: ') }));
    if ((move && move.to === loc.address) || ((extra.lookAround || extra.look?.kind === 'around') && !move)) lines.push(P('narration.exits_hint'));
    lines.push(toolsOn ? P('narration.rules_tools') : P('narration.rules', { party: who }));
    return renderTokens(lines.filter(Boolean).join('\n'));
}
/** {{npc:id}} -> the cast name (before ST macros run); an unknown id shows as the bare id, with a console warning. */
export function renderTokens(text) {
    const pack = castPack();
    return renderNpcTokens(text, pack?.npcs ?? [], id => console.warn(`[WorldScrawl] {{npc:${id}}}: no cast NPC has that id; shown as "${id || 'someone'}".`));
}
/** Where the player stood at message i (for lore scenes; works without a cast). */
function lorePlayerAt(chat, loc) {
    const end = Math.max(0, (chat?.length ?? 1) - 1);
    return i => (i >= end && loc?.address ? loc.address : (positionOf(chat, Math.min(Math.max(i, 0), end), PLAYER)?.address || loc?.address || ''));
}
/** The lore chain entries fed this turn (asked for by flag or [lore] in this scene, at this place). */
export function fedLore(loc, extra = []) {
    const chat = ctx().chat ?? [];
    try { return activeLore(chat, chat.length - 1, loc?.lore_chain ?? [], lorePlayerAt(chat, loc), extra); } catch (e) { console.warn('[WorldScrawl] lore', e.message); return []; }
}
/** The lore index line and the fed-lore block for factsText. */
export function loreBits(loc, toolsOn) {
    const chain = loc?.lore_chain ?? [];
    if (!chain.length) return {};
    const fed = fedLore(loc);
    return {
        lore_index: P('narration.lore_index', { lore_places: chain.map(c => c.name).join(', '), how: P(toolsOn ? 'narration.lore_how_tools' : 'narration.lore_how_tags') }),
        lore_fed: fed.length ? P('narration.lore_block', { lore: fed.map(c => `- ${c.name}: ${c.text}`).join('\n') }) : '',
    };
}
/** Stamp a lore request for `place` (a name, or ''/"here" for all) on msg. Returns the matched chain entries. */
function requestLore(msg, loc, place, source) {
    const hits = loreFor(loc?.lore_chain ?? [], place);
    if (hits.length) for (const h of hits) addLoreRequest(msg, { place: h.name, level: h.level, address: loc.address, source });
    else addLoreRequest(msg, { place, level: '', address: loc?.address ?? '', source });
    return hits;
}

const REMEMBER_KEY = 'worldscrawl_remember';
const FOCUS_KEY = 'worldscrawl_focus';
let pendingNpc = []; // ws_npc tool calls, stamped on the reply
function castPack() {
    const id = activeWorld || defaultWorldId;
    return (id && worldCasts.get(id)) || (defaultWorldId && worldCasts.get(defaultWorldId)) || null;
}
function chatRelocate(chat) {
    const out = {};
    for (const m of chat ?? []) for (const p of m?.extra?.[PATCH_KEY] ?? []) {
        if (!p || p.off === true) continue;
        for (const [k, v] of Object.entries(p.relocate ?? {})) out[k] = v;
    }
    return out;
}
function npcClock(chat, i) {
    const elapsed = clockAt(Math.max(0, i), chat);
    const t = worldTimes.get(activeWorld || defaultWorldId);
    if (!calendarLib || !t) return { day: 0, hour: 8, minute: 0, minutes: 8 * 60, elapsed };
    try {
        const d = calendarLib.dateAt(elapsed, t.start_date, t.calendar);
        return { day: d.day_number, hour: d.hour, minute: d.minute, minutes: d.hour * 60 + d.minute, elapsed };
    } catch { return { day: 0, hour: 8, minute: 0, minutes: 8 * 60, elapsed }; }
}
function npcEnv(chat, loc) {
    const pack = castPack();
    const relocate = chatRelocate(chat);
    const addresses = pack?.places ?? new Set();
    const end = Math.max(0, (chat?.length ?? 1) - 1);
    const exists = a => !!a && addresses.has(a) && !Object.prototype.hasOwnProperty.call(relocate, a);
    const rawAt = i => (i >= end && loc?.address ? loc.address : (positionOf(chat, Math.min(Math.max(i, 0), end), PLAYER)?.address || loc?.address || ''));
    return {
        exists, relocate,
        names: a => pack?.labels?.[a] || (loc?.address === a ? (loc.display_name || loc.name || a) : a),
        playerAt: i => { const raw = rawAt(i); const r = resolveSchedulePlace(raw, { exists, relocate }); return r.ok ? r.address : raw; },
        actorAt: (i, id) => positionOf(chat, Math.min(Math.max(i, 0), end), id)?.address || '',
        clock: i => npcClock(chat, Math.min(Math.max(i, 0), end)),
    };
}
function addNpcStamp(msg, stamp) {
    msg.extra = msg.extra ?? {};
    msg.extra[NPC_KEY] = [...(Array.isArray(msg.extra[NPC_KEY]) ? msg.extra[NPC_KEY] : []), { ...stamp, swipe: swipeOf(msg) }];
}
/** People-here text for the narrator. Empty when nobody saved is in the scene, so turns without them stay as they were. */
function npcPromptBits(loc) {
    const pack = castPack();
    const chat = ctx().chat ?? [];
    if (!pack?.npcs?.length || !chat.length || !calendarLib) return {};
    try {
        const env = npcEnv(chat, loc);
        const present = presentAt(chat, chat.length - 1, pack.npcs, env);
        const lore = fedLore(loc).map(c => c.text).join('\n'); // absence lines only for {{npc:id}} in lore being fed
        const absent = absentAt(chat, chat.length - 1, pack.npcs, env, { lore, present });
        if (!present.length && !absent.length) return {};
        if (!present.length) return { npcs_present: `(none)\n${absent.join('\n')}`, npc_focus: '' };
        const ui = lastUserIndex(chat);
        const stored = ui >= 0 ? chat[ui]?.extra?.[FOCUS_KEY] : null;
        const said = ui >= 0 ? chat[ui]?.mes ?? '' : '';
        const focus = stored && stored.depth ? stored : focusRules(said, present);
        const asked = askedLoreNames(chat, chat.length - 1, i => env.playerAt(i));
        const sl = npcSlices(present, focus, { tiers: npcTiers(present, focus, { chat, index: chat.length - 1, said, asked }) });
        return { ...sl, ...(absent.length ? { npcs_present: `${sl.npcs_present}\n${absent.join('\n')}` } : {}) };
    } catch (e) { console.warn('[WorldScrawl] npcs', e.message); return {}; }
}
const DRAMATIC_RE = /\b(attacks?|stab(?:s|bed)?|rescues?|sav(?:e|es|ed)|kills?)\b/i;
const DISPO_OPTS = [
    { key: 'indifferent', label: 'the usual answer; no reason to feel strongly either way' },
    { key: 'unfriendly', label: 'cold, short or suspicious' },
    { key: 'friendly', label: 'warm, glad to see them' },
    { key: 'helpful', label: 'goes out of their way to help' },
    { key: 'hostile', label: 'wants to harm them' },
];
async function askDisposition(person, said) {
    await ensurePrompts();
    const prompt = P('npc.disposition', { name: person.name, line: person.line, party: partyText(), said: String(said ?? '').slice(0, 800), options: optionLines(DISPO_OPTS) });
    const hit = await askValid('disposition', prompt, pickKey(DISPO_OPTS));
    return hit?.key ?? 'indifferent';
}
async function askWho(loc, said, present) {
    await ensurePrompts();
    const opts = [...present.map(p => ({ key: p.id, label: p.name })), { key: 'nobody', label: 'nobody in particular' }];
    const prompt = P('npc.who', { party: partyText(), place: displayName(loc), said: String(said ?? '').slice(0, 800), options: optionLines(opts) });
    const hit = await askValid('who', prompt, pickKey(opts));
    return hit?.key && hit.key !== 'nobody' ? hit.key : null;
}
/** Before the narrator speaks: sighting stamps, a first attitude, and who is in focus. One pick-one, one retry, then indifferent. */
async function prepareNpcs(userMsg) {
    const pack = castPack();
    const chat = ctx().chat ?? [];
    if (!pack?.npcs?.length || !userMsg || !chat.length) return;
    if (userMsg.extra?.worldscrawl_npc_ready) return;
    userMsg.extra = userMsg.extra ?? {};
    userMsg.extra.worldscrawl_npc_ready = true;
    await loadCalendar();
    const loc = await currentLocation().catch(() => null);
    if (!loc || !calendarLib) return;
    const env = npcEnv(chat, loc);
    const index = chat.length - 1;
    const clock = env.clock(index);
    const here = env.playerAt(index);
    const frame = framesOf(chat, index, pack.npcs);
    const now = frame[frame.length - 1];
    const said = userMsg.mes ?? '';
    const seeking = /\b(find|seek|where is|look for|ask after|ask about)\b/i.test(said);
    if (now) for (const n of now.values()) {
        const oneOff = n.seen_at && !(n.schedule ?? []).some(e => !e.broken);
        if (seeking && oneOff && (nameIn(said, n.name) || nameIn(said, n.id)) && !n.seeks.some(s => s.day === clock.day)) addNpcStamp(userMsg, { type: 'npc_seek', id: n.id, day: clock.day });
        const check = sightCheck(n, clock, here, env, { appearances: n.appearances, seeks: n.seeks, useRoll: true });
        if (check.present && check.needsStamp) addNpcStamp(userMsg, { type: 'npc_appear', id: n.id, place: check.place, day: clock.day, hour: clock.hour });
    }
    let present = presentAt(chat, index, pack.npcs, env);
    for (const p of present) {
        if (p.disposition?.player?.value !== 'unknown' || (p.fromCast ?? []).includes(PLAYER)) continue;
        const value = await askDisposition(p, said);
        addNpcStamp(userMsg, { type: 'npc_disposition', id: p.id, who: PLAYER, value, reason: value === 'indifferent' ? 'No strong impression.' : '', ...(DRAMATIC_RE.test(said) ? { dramatic: true } : {}) });
    }
    present = presentAt(chat, index, pack.npcs, env);
    const rules = focusRules(said, present);
    let focus = rules;
    if (rules.ambiguous && present.length) {
        const id = await askWho(loc, said, present);
        focus = { id, depth: id ? (rules.depth === 'deep' ? 'deep' : 'focused') : 'present', ambiguous: false };
    }
    userMsg.extra[FOCUS_KEY] = { id: focus.id ?? null, depth: focus.depth ?? 'present', swipe: swipeOf(userMsg) };
}
function knownNpcNames(chat) {
    const pack = castPack();
    const names = [...(pack?.names ?? []), ...(pack?.npcs ?? []).flatMap(n => [n.name, n.id])];
    const frames = framesOf(chat, chat.length - 1, pack?.npcs ?? []);
    const end = frames[frames.length - 1];
    if (end) for (const n of end.values()) names.push(n.name, n.id);
    return names;
}
async function offerRemember(msg, name) {
    const chat = ctx().chat ?? [];
    let who = String(name ?? '').trim();
    if (!who) who = flaggedInScene(chat, chat.length - 1)[0]?.name ?? ''; // bare [remember]: the most recently flagged unsaved person
    if (!who) { toastr.info('WorldScrawl: say who to remember, e.g. /ws-npc Maren'); return; }
    const known = knownNpcNames(chat);
    if (known.some(n => normName(n) === normName(who) || nameIn(who, n))) { toastr.info(`WorldScrawl: ${who} is already remembered.`); return; }
    msg.extra = msg.extra ?? {};
    msg.extra[REMEMBER_KEY] = { swipe: swipeOf(msg), name: who, status: 'review', nid: newNoticeId('remember') };
    await ctx().saveChat?.();
    renderPatchCards();
}
async function keepRemember(id, edited = null) {
    const c = ctx(), msg = c.chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return;
    const nid = noticeIdOf(card, 'remember');
    return once(nid, async () => {
        if (!markDecided(msg, nid, edited ? 'adjust' : 'approve', { swipe: swipeOf(msg), text: `remember ${edited?.name?.trim() || card.name}` })) return; // decided once: a second Approve is a no-op
        try { await keepRememberNow(c, msg, card, id, edited); } catch (e) { unmarkDecided(msg, nid); renderPatchCards(); throw e; }
    });
}
async function keepRememberNow(c, msg, card, id, edited) {
    const chat = c.chat ?? [];
    const name = edited?.name?.trim() || card.name;
    const [, loc] = await Promise.all([ensurePrompts(), currentLocation().catch(() => null)]);
    const blank = { manner: '', voice: '', looks: '', body: '', outfit: '', history: '', unknownAs: '', facts: [], invented: [] };
    let got = edited?.line ? { ...blank, name, line: edited.line.trim() } : null;
    if (!got) {
        const back = readBack(chat.slice(0, id + 1).filter(m => !m.is_system).map((m, i) => ({ text: m.mes ?? '', index: i })), name);
        const story = back.messages.map(m => m.text).join('\n').slice(0, 6000);
        const prompt = P('npc.remember', { name, place: loc ? displayName(loc) : 'here', story: story || '(nothing was said yet)' });
        for (let t = 0; t < 2 && !got; t++) {
            try { got = readRememberAnswer(parseJsonAnswer(await gen('remember', { prompt, systemPrompt: P('npc.remember_system', { reply: baseReply('json') }), responseLength: 900 }, { at: id, retry: t > 0 }))); } catch { got = null; }
            if (!got) markLast(id, 'remember', 'failed', 'answer was not a usable person');
        }
        if (!got) got = { ...blank, name, line: 'Met in this scene.' };
    }
    const taken = new Set(knownNpcNames(chat));
    const newId = freeId(got.name, taken);
    addNpcStamp(msg, { type: 'npc_create', id: newId, name: got.name, line: got.line, manner: got.manner, voice: got.voice,
        ...Object.fromEntries(['looks', 'body', 'outfit', 'history', 'unknownAs'].filter(k => got[k]).map(k => [k, got[k]])), facts: got.facts, ...(got.invented?.length ? { invented: got.invented } : {}) });
    if (got.disposition) addNpcStamp(msg, { type: 'npc_disposition', id: newId, who: PLAYER, value: got.disposition.value, reason: got.disposition.reason ?? '', dramatic: true });
    card.status = 'kept'; card.name = got.name;
    const d = decisionOf(msg, card.nid); if (d) d.text = `remembered ${got.name}`;
    syncSwipeExtra(msg);
    renderPatchCards(); // show the result at once; saving and the prompt refresh follow
    toastr.success(`WorldScrawl: ${got.name} remembered. Delete this message to undo it.`);
    await c.saveChat?.();
    await applyFacts();
    renderPatchCards();
}
async function discardRemember(id) {
    const c = ctx(), msg = c.chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return;
    if (!markDecided(msg, noticeIdOf(card, 'remember'), 'discard', { swipe: swipeOf(msg), text: `not remembering ${card.name} this scene` })) return;
    addNpcStamp(msg, { type: 'npc_decline', name: card.name });
    card.status = 'declined';
    syncSwipeExtra(msg);
    await c.saveChat?.();
    renderPatchCards();
}
/** Unsaved people the narrator flagged ([ws_flag: npc | Name]) in the scene holding message `id`, most recent first, with counts. */
export function flaggedInScene(chat, id) {
    if (id < 0 || !chat?.length) return [];
    const at = i => positionOf(chat, i, PLAYER)?.address || '';
    const declined = declinesInScene(chat, id, at);
    return flaggedPeople(chat, sceneStartOf(chat, id, at), id, { known: knownNpcNames(chat), declined: [...declined], threshold: SUGGEST_AFTER });
}
function maybeSuggest(id) {
    const chat = ctx().chat ?? [];
    const pack = castPack();
    const msg = chat[id];
    if (!pack || !msg || msg.extra?.[REMEMBER_KEY]) return;
    const known = knownNpcNames(chat);
    const hit = flaggedInScene(chat, id).find(s => s.ready && !chat.some(m => normName(m?.extra?.[REMEMBER_KEY]?.name ?? '') === s.key));
    if (!hit) return;
    msg.extra = msg.extra ?? {};
    msg.extra[REMEMBER_KEY] = { swipe: swipeOf(msg), name: hit.name, status: 'review', suggested: true };
}
async function exportNpc(id, { update = false } = {}) {
    const chat = ctx().chat ?? [];
    const pack = castPack();
    const npc = npcAt(chat, chat.length - 1, pack?.npcs ?? [], id);
    const record = npc ? exportRecord(npc) : null;
    if (!record) { toastr.warning('WorldScrawl: that person is not in this chat.'); return; }
    const r = await api('/cast/export', { method: 'POST', body: JSON.stringify({ npc: record, ...(update ? { update: true } : {}) }) });
    if (!r.ok) { const msg = typeof r.body?.detail === 'string' ? r.body.detail : 'Could not export.'; toastr.warning(msg); return { ok: false, error: msg }; }
    rememberWorlds((await api('/worlds').catch(() => null))?.body);
    const where = `cast/${r.body.file}`;
    toastr.success(r.body.updated ? `WorldScrawl: updated ${where}.` : `WorldScrawl: wrote ${where}${r.body.renamed ? ` (as ${r.body.id}, the old file was kept)` : ''}.`);
    broadcastMapState();
    return { ok: true, id: r.body.id, file: r.body.file, updated: !!r.body.updated };
}
/** The map's cast browser: every saved person in this chat, where they are, their stamps, and the Update diff against their cast file. */
function mapNpcs(chat, here) {
    const pack = castPack();
    if (!pack) return [];
    try {
        return npcPlayState(chat ?? [], pack.npcs ?? [], npcEnv(chat ?? [], here)).map(n => {
            const castNpc = (pack.npcs ?? []).find(x => x.ok && x.id === n.id) ?? null;
            const { record, ...rest } = n;
            return { ...rest, record, inCast: !!castNpc, diff: castNpc ? recordDiff(castNpc, n) : null };
        });
    } catch (e) { console.warn('[WorldScrawl] npc state for the map failed', e); return []; }
}
/** The per-message activity log for the map: the last 30 messages, newest first, with sighting rolls at each. */
function mapActivity(chat, here) {
    if (!chat?.length) return [];
    const c = ctx(), chatId = c.chatId ?? c.getCurrentChatId?.();
    const pack = castPack();
    let env = null, frames = null;
    try { env = npcEnv(chat, here); frames = framesOf(chat, chat.length - 1, pack?.npcs ?? []); } catch { /* no world */ }
    const out = [];
    for (let i = chat.length - 1; i >= 0 && out.length < 30; i--) {
        const m = chat[i]; if (!m) continue;
        const rolls = [];
        if (env && frames?.[i] && !m.is_user) for (const n of frames[i].values()) {
            if (!n.seen_at) continue;
            try { const w = npcWhy(n, i, env); const g = w.sighting; if (g?.active && g.roll != null) rolls.push({ kind: 'roll', label: `${n.name} sighting${g.sought ? ' (by name)' : ''}`, roll: g.used, chance: g.now, seekRoll: g.seekRoll, present: g.wouldShow }); } catch { /* skip */ }
        }
        out.push({ msg: i, who: m.is_user ? 'you' : m.is_system ? 'system' : m.name ?? 'narrator', snippet: String(m.mes ?? '').slice(0, 80), entries: messageActivity(m, i, { chatId, extra: rolls }) });
    }
    return out;
}
/** The map inspector: who is at each place that matters (with no-show reasons), what the narrator was told per reply, and unsaved people. */
function mapInspect(chat, here) {
    const pack = castPack();
    if (!pack || !chat?.length) return null;
    try {
        const env = npcEnv(chat, here);
        const end = chat.length - 1;
        const places = new Set([here?.address].filter(Boolean));
        for (const n of pack.npcs ?? []) { for (const e of n.schedule ?? []) if (e?.place) places.add(resolveSchedulePlace(e.place, env).address ?? e.place); if (n.seen_at?.place) places.add(resolveSchedulePlace(n.seen_at.place, env).address ?? n.seen_at.place); }
        for (const n of mapNpcs(chat, here)) if (n.position?.place) places.add(n.position.place);
        const who = {};
        for (const a of places) who[a] = whoAt(chat, end, pack.npcs ?? [], env, a);
        const narrator = [];
        for (let i = end; i > 0 && narrator.length < 15; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) { const v = narratorView(chat, i, pack.npcs ?? [], env, FOCUS_KEY); if (v) narrator.push(v); }
        const unsaved = unsavedPeople(chat, { known: knownNpcNames(chat), threshold: SUGGEST_AFTER, playerAt: i => env.playerAt(i) || '', rememberKey: REMEMBER_KEY });
        return { who, narrator, unsaved, threshold: SUGGEST_AFTER };
    } catch (e) { console.warn('[WorldScrawl] npc inspector failed', e); return null; }
}
/** "In this chat" edits from the map: stamps on the latest message, only if the chat, message and swipe are still the ones the map saw. */
const CHAT_EDIT_TYPES = new Set(['npc_fact', 'npc_memory', 'npc_disposition']);
async function npcChatEdit(d) {
    const c = ctx(), chat = c.chat ?? [];
    if (!d.chatId || d.chatId !== (c.chatId ?? c.getCurrentChatId?.())) return { ok: false, error: 'That chat is not open in SillyTavern any more.' };
    const i = Number(d.msg), msg = chat[i];
    if (!msg || i !== chat.length - 1) return { ok: false, error: 'The chat has moved on since the map loaded; check the In this chat view again.', stale: true };
    if ((d.swipe ?? null) !== (swipeOf(msg) ?? null)) return { ok: false, error: 'That message is on a different swipe now.', stale: true };
    const id = String(d.id ?? '');
    if (!npcAt(chat, i, castPack()?.npcs ?? [], id)) return { ok: false, error: 'That person is not in this chat.' };
    const stamps = (Array.isArray(d.stamps) ? d.stamps : []).filter(s => s && CHAT_EDIT_TYPES.has(s.type)).map(s => ({ ...s, id, by: 'map' }));
    if (!stamps.length) return { ok: false, error: 'Nothing changed.' };
    for (const s of stamps) addNpcStamp(msg, s);
    syncSwipeExtra(msg);
    await c.saveChat?.();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, count: stamps.length, msg: i };
}
function npcDetail(id) {
    const chat = ctx().chat ?? [];
    const npc = npcAt(chat, chat.length - 1, castPack()?.npcs ?? [], id);
    if (!npc) return 'No saved person with that id is here.';
    const bits = [`Personality: ${npc.line}`];
    if (npc.manner) bits.push(`Manner: ${npc.manner}`);
    if (npc.voice) bits.push(`Speech: ${npc.voice}`);
    if (npc.looks) bits.push(`Looks: ${npc.looks}`);
    if (npc.body) bits.push(`Body: ${npc.body}`);
    if (npc.outfit) bits.push(`Wearing: ${npc.outfit}`);
    if (npc.memory?.length) bits.push(`Memory: ${npc.memory.join('; ')}`);
    if (npc.deep?.history) bits.push(`History: ${npc.deep.history}`);
    if (npc.deep?.secrets?.length) bits.push(`Secrets: ${npc.deep.secrets.join('; ')}`);
    if (npc.deep?.relationships) bits.push(`Relationships: ${Object.entries(npc.deep.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    return bits.filter(Boolean).join('\n');
}
function toolNpcStamp(args = {}) {
    const action = String(args.action ?? '').toLowerCase();
    const id = String(args.id ?? '').trim();
    if (!id) return null;
    if (action === 'fact') return args.text ? { type: 'npc_fact', id, field: 'fact', text: String(args.text) } : null;
    if (action === 'memory') return args.text ? { type: 'npc_memory', id, note: String(args.text) } : null;
    if (action === 'disposition') return { type: 'npc_disposition', id, who: PLAYER, value: args.value, reason: String(args.reason ?? args.text ?? '') };
    if (action === 'leave') return { type: 'npc_leave', id };
    if (action === 'staying') return { type: 'npc_staying', id, elapsed: chatElapsed() };
    if (action === 'follow') return { type: 'npc_follow', id, who: PLAYER };
    if (action === 'stay') return { type: 'npc_stay', id };
    if (action === 'seek') return { type: 'npc_seek', id, day: npcClock(ctx().chat ?? [], (ctx().chat ?? []).length - 1).day };
    return null;
}

async function applyFacts() {
    await ensurePrompts();
    const c = ctx();
    if (!isOn()) { c.setExtensionPrompt(FACTS_KEY, '', 1, 1, false, 0); c.setExtensionPrompt(REMINDER_KEY, '', 1, 0, false, 0); return; }
    let text = '', reminder = '';
    try {
        const loc = await currentLocation();
        const ui = lastUserIndex(c.chat ?? []);
        const move = ui >= 0 ? c.chat[ui].extra?.[MOVE_KEY] : null;
        const um = ui >= 0 ? c.chat[ui].extra ?? {} : {};
        await loadCalendar();
        const d = gameDate();
        text = factsText(loc, move, toolsOn(), { date: d ? calendarLib.describeDate(d) : '', weather: placeWeatherNow(loc)?.line ?? '', took: move?.seconds && calendarLib ? calendarLib.formatDuration(move.seconds) : '', dig: um.worldscrawl_dig, digFailed: um.worldscrawl_dig_failed, look: um.worldscrawl_look, newDoor: um.worldscrawl_new_door, lookAround: ui >= 0 && LOOK_AROUND_RE.test(c.chat[ui].mes ?? '') && !(um.worldscrawl_look && (um.worldscrawl_look.via || um.worldscrawl_look.window)), door: um.worldscrawl_door, open: doorOverrides(), ...loreBits(loc, toolsOn()), ...npcPromptBits(loc) });
        reminder = arrivalReminder(loc, move);
        const ep = expiryPending?.chat === chatKey() && expiryPending.to === loc.address ? expiryPending : null;
        if (ep) { ep.used = true; if (ep.line) text = `${text}\n${ep.line}`; }
        const rn = ep ? '' : relocationNote(c.chat ?? [], loc, partyText());
        if (rn) text = `${text}\n${rn}`;
        else if (!ep) { const am = await aftermathNote(c.chat ?? [], loc).catch(() => ''); if (am) text = `${text}\n${am}`; }
        const wf = await waitFacts(c.chat ?? [], loc);
        if (wf) text = `${text}\n${wf}`;
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    // Small models weigh the last lines most: on a move/travel turn, repeat where the turn ends after the player's message.
    c.setExtensionPrompt(REMINDER_KEY, reminder, 1 /* IN_CHAT */, 0, false, 0 /* SYSTEM */);
}

/** The model never sees the [ws-start] marker (the prompt chat holds its own entries: replace them, the stored greeting stays). */
export function stripStartMarker(arr) {
    if (!Array.isArray(arr)) return;
    arr.forEach((m, i) => { if (typeof m?.mes === 'string' && m.mes.includes(START_MARKER)) arr[i] = { ...m, mes: m.mes.split(START_MARKER).join('').replace(/[ \t]+\n/g, '\n').trim() }; });
}

/** Generation interceptor (manifest.generate_interceptor): runs before every prompt is built. */
globalThis.worldscrawlInterceptor = async function (_chat, _size, abort, type) {
    stripStartMarker(_chat);
    _chat.forEach((m, i) => { if (m?.is_user && typeof m.mes === 'string' && m.mes.includes('[')) { const t = unbracket(m.mes); if (t !== m.mes) _chat[i] = { ...m, mes: t }; } });
    if (type === 'quiet' || type === 'impersonate' || !isOn()) return;
    try {
        const c = ctx();
        const chat = c.chat ?? [];
        const last = chat[chat.length - 1];
        const s = settings();
        const bracket = (!type || type === 'normal') && last?.is_user && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked ? parseBracket(last.mes) : null;
        if (bracket || ((!type || type === 'normal') && last?.is_user && s.moveMode === 'typed'
            && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked)) {
            const r = (bracket && await bracketIntent(last, bracket)) || await parseIntent(last);
            await c.saveChat();
            if (r.kind === 'help' || r.kind === 'bracket_failed') {
                abort(true); // answered here: the narrator is not called
                await addNotice({ loc: r.loc, kind: 'text', text: r.kind === 'help' ? helpText() : r.note });
                renderAllExits();
                return;
            }
            await c.saveChat();
            if (r.kind === ELSEWHERE || r.kind === 'which' || r.kind === 'already') {
                abort(true); // no model call: the model would only narrate a trip that didn't happen
                await addNotice(r.kind === 'which' ? { loc: r.loc, kind: 'which', candidates: r.candidates, prefix: r.prefix ?? WHICH_PREFIX }
                    : r.kind === 'already' ? { loc: r.loc, kind: 'already', name: r.name } : { loc: r.loc, noRoute: r.noRoute });
                renderAllExits();
                return;
            }
            if (r.kind === 'dig_failed') toastr.warning(`WorldScrawl: ${DIG_FAILED_NOTICE}`);
            renderAllExits();
        }
        if ((!type || type === 'normal') && last?.is_user) await prepareNpcs(last);
        await applyFacts();
    } catch (e) { console.error('[WorldScrawl] interceptor failed', e); }
};

/** A system message (never in the prompt) carrying one world change; deleting it undoes the change. */
async function addChangeMessage(text, change) {
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text, extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'change', [CHANGE_KEY]: change } };
    c.chat.push(msg); c.addOneMessage(msg); await c.saveChat();
    renderAllExits();
}
/** "Village Square" for streets-like places, otherwise "Room (Building)". */
const roomLabel = l => (l.subregion?.label_rooms ? l.name : displayName(l));
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', northeast: 'southwest', southwest: 'northeast', northwest: 'southeast', southeast: 'northwest', up: 'down', down: 'up', in: 'out', out: 'in', inside: 'outside', outside: 'inside' };
/** Return exit name for a dug exit: the opposite for compass/up/down/in/out, otherwise "back". */
export const returnName = d => OPPOSITE[String(d).toLowerCase()] ?? 'back';
const hasExit = (loc, d) => !!loc?.exits?.some(e => e.direction.toLowerCase() === String(d).toLowerCase());
/** Unique id for a new room in the subregion of `near`: "<name_slug>_<time>". */
const newRoomAddress = (near, name) => `${near.address.split('/')[0]}/${(slug(name).replace(/-/g, '_') || 'room').slice(0, 30).replace(/_+$/, '')}_${Date.now().toString(36)}`; // ids: lowercase, digits, single underscores
/**
 * Build a dig (and new room) from validated parts. Returns {ok, change, text} or {ok:false, error}.
 * dest: {address} of a room, or {name, description} for a new room. Never touches the chat.
 */
export async function buildDig(here, direction, dest, { returnDirection = null, oneway = false, description = '', returnDescription = '' } = {}) {
    direction = String(direction ?? '').trim();
    if (!direction || direction.length > 30) return { ok: false, error: 'An exit needs a short name.' };
    if (hasExit(here, direction)) return { ok: false, error: `There is already an exit ${direction} here.` };
    const back = String(returnDirection ?? returnName(direction)).trim();
    const changes = [];
    let to, label;
    if (dest.address) {
        if (dest.address === here.address) return { ok: false, error: 'A passage must lead somewhere else.' };
        const t = await fetchLocationCached(dest.address);
        if (!t) return { ok: false, error: 'No such place.' };
        if (!oneway && hasExit(t, back)) return { ok: false, error: `${roomLabel(t)} already has an exit ${back}.` };
        to = t.address; label = roomLabel(t);
    } else {
        const name = String(dest.name ?? '').trim(), desc = String(dest.description ?? '').trim();
        if (!name || name.length > 40 || !desc || desc.length > 300) return { ok: false, error: 'A new room needs a short name and description.' };
        to = newRoomAddress(here, name); label = name;
        changes.push({ type: 'add_room', address: to, name, description: desc, from: here.address });
    }
    const d = description ? { description } : {};
    changes.push(oneway ? { type: 'add_exit', from: here.address, direction, to, ...d }
        : { type: 'dig', from: here.address, direction, to, ...d, return_direction: back, ...(returnDescription ? { return_description: returnDescription } : {}) });
    const text = `[Engine: a passage ${direction} to ${label} was opened${oneway ? '' : ` (back: ${back})`}.]`;
    return { ok: true, change: changes.length === 1 ? changes[0] : changes, text, to, label, direction, back: oneway ? null : back };
}
/**
 * /ws-dig <dir>[/<returndir>] <known place> | /ws-dig <dir>[/<returndir>] new <name>[: description]
 * Two-way by default (oneway=true for one-way). Undo by deleting the system message.
 */
export async function digAction(arg, { oneway = false } = {}) {
    const m = String(arg ?? '').trim().match(/^(\S+)\s+(.+)$/);
    const usage = 'Usage: /ws-dig <dir>[/<returndir>] <known place>  or  /ws-dig <dir> new <name>[: description]';
    if (!m) { toastr.warning(usage); return ''; }
    const [direction, returnDirection = null] = m[1].split('/');
    const placeText = m[2].trim();
    const here = await currentLocation();
    let dest;
    const nm = placeText.match(/^new\s+([^:]+?)\s*(?::\s*(.+))?$/i);
    if (nm) dest = { name: nm[1], description: nm[2] ?? `A newly opened space off ${roomLabel(here)}.` };
    else {
        const known = await discoveredPlaces();
        const list = [...known.values()].map(l => ({ address: l.address, name: l.name, label: l.display_name }));
        const found = known.has(placeText) ? [{ address: placeText, label: known.get(placeText).display_name }] : matchCandidates(placeText, list);
        if (found.length !== 1) { toastr.warning(found.length > 1 ? `Which one? ${found.map(x => x.label).join(', ')}` : `Not a known place: ${placeText}`); return ''; }
        dest = { address: found[0].address };
    }
    const r = await buildDig(here, direction, dest, { returnDirection, oneway });
    if (!r.ok) { toastr.warning(r.error); return ''; }
    await addChangeMessage(r.text, r.change);
    return '';
}
/** /ws-removeexit <direction>: remove an exit from the current room only. */
export async function removeExitAction(arg) {
    const direction = String(arg ?? '').trim();
    const here = await currentLocation();
    const e = here.exits.find(x => x.direction.toLowerCase() === direction.toLowerCase());
    if (!e) { toastr.warning(`No exit ${direction} here. ${exitsText(here)}`); return ''; }
    await addChangeMessage(`[Engine: the ${e.direction} exit from ${roomLabel(here)} was removed.]`, { type: 'remove_exit', from: here.address, direction: e.direction });
    return '';
}
const slug = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** The chat's default save name: "<base world> - <character or chat> - <Mon D, h:mm AM>" (also the Save box placeholder). */
export function defaultWorldName(now = new Date()) {
    const c = ctx();
    const who = c.groupId ? (c.groups?.find?.(g => g.id === c.groupId)?.name ?? 'Group') : (c.name2 || c.chatId || 'Chat');
    const when = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${worldName(chatWorld()?.id ?? activeWorld)} - ${who} - ${when}`;
}
/** Readable folder hint for a generated name: "riverton-desirae-oct-19" (the server adds -2, -3... if taken). */
const autoIdHint = (now = new Date()) => { const c = ctx(); return [worldName(chatWorld()?.id ?? activeWorld), c.name2 || 'chat', now.toLocaleString('en-US', { month: 'short' }), now.getDate()].map(slug).filter(Boolean).join('-'); };
/**
 * Save box placeholder (= what a blank save uses): on a living save, that world's own name (blank = save over it);
 * on a pristine world, a generated "<base> - <character> - <date>" name. Typing a new name branches a copy.
 */
function refreshSaveName() {
    const i = document.getElementById('worldscrawl_save_name');
    if (!i) return;
    const cur = chatWorld()?.id ?? activeWorld ?? '';
    const id = cur || defaultWorldId;
    placeholderAuto = !worldLiving.get(id);
    i.placeholder = placeholderAuto ? defaultWorldName() : worldName(id);
}
/**
 * Render this chat (its world + its changes) into a new world folder. With switchChat, stamp a rebase on the
 * latest message: from then on the chat is built on the new world and only changes stamped after it are replayed.
 */
// Overridable for tests.
export const hooks = { confirm: async text => { const c = ctx(); return !!c.callGenericPopup && await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM) === c.POPUP_RESULT.AFFIRMATIVE; } };

export async function saveWorld(name, switchChat = true, withKnowledge = false, { overwrite = false, confirm = false } = {}) {
    syncWorld();
    if (!worldNames.size) rememberWorlds((await api('/worlds').catch(() => null))?.body);
    name = String(name ?? '').trim();
    const cur = activeWorld || defaultWorldId;
    if (!name) name = worldLiving.get(cur) ? worldName(cur) : defaultWorldName(); // same rule as the placeholder
    const auto = !worldLiving.get(cur) && (name === defaultWorldName() || (name === document.getElementById('worldscrawl_save_name')?.placeholder && placeholderAuto));
    let knowledge = null;
    if (!(await loadCalendar())) { const e = 'Not saved: the game clock (calendar.mjs) could not be loaded.'; toastr.error(e); return { ok: false, error: e }; }
    if (withKnowledge) { // what this chat knows, for new chats on the saved world (written to knowledge.json)
        const here = await currentLocation();
        const stood = [...await stoodInAddresses()];
        const seen = [...(await discoveredPlaces()).keys()].filter(a => !stood.includes(a));
        knowledge = { location: here.address, stood, seen, doors: [...await syncDoors()] };
    }
    const body = { base: activeWorld || null, name, auto, elapsed: chatElapsed(), ...(auto ? { id_hint: autoIdHint() } : {}), ...mapCtx(), ...(knowledge ? { knowledge } : {}) };
    let r = await api('/worlds/render', { method: 'POST', body: JSON.stringify({ ...body, overwrite }) });
    if (!r.ok && r.body?.detail?.error === 'needs_overwrite') {
        // Name of ANOTHER living world: the panel asks; /ws-save-world needs overwrite=true.
        const other = r.body.detail.name;
        const yes = confirm && await hooks.confirm(`Save over the world "${other}"? Its current version is kept as the one backup.`);
        if (!yes) {
            const e = confirm ? 'Not saved.' : `A world named "${other}" already exists. Add overwrite=true to save over it.`;
            (confirm ? toastr.info : toastr.warning)(e); return { ok: false, error: e };
        }
        r = await api('/worlds/render', { method: 'POST', body: JSON.stringify({ ...body, overwrite: true }) });
    }
    if (!r.ok) { const e = typeof r.body?.detail === 'string' ? r.body.detail : r.body?.detail?.message ?? r.body?.detail?.error ?? `Save failed (${r.status})`; toastr.error(e); return { ok: false, error: e }; }
    worldNames.set(r.body.id, r.body.name); worldLiving.set(r.body.id, !!r.body.living);
    if (r.body.start_date) worldTimes.set(r.body.id, { calendar: r.body.calendar, start_date: r.body.start_date, weather: r.body.weather });
    // Saved over the world this chat is on: always rebase here, or changes since the last switch would be replayed twice.
    const overSelf = !!r.body.overwritten && r.body.id === cur;
    if (overSelf) switchChat = true;
    if (r.body.overwritten) { for (const k of [...exitsCache.keys()]) if (k.startsWith(`${r.body.id}|`)) exitsCache.delete(k); doorInfo.clear(); doorFetched.clear(); }
    // A system message records the save; with switch on it carries the rebase stamp (delete it to go back).
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'saved' },
        mes: overSelf ? `[Engine: world "${r.body.name}" saved over its previous version.]` : `[Engine: world saved as "${r.body.name}"${r.body.overwritten ? ' (over its previous version)' : ''}.${switchChat ? ' This chat now uses it.' : ''}]` };
    c.chat.push(msg);
    if (switchChat) { lastSyncChat = null; msg.extra[WORLD_KEY] = { id: r.body.id, name: r.body.name, version: r.body.map_version, rebase: true, at: c.chat.length - 1, from: activeWorld || null }; }
    c.addOneMessage(msg);
    await c.saveChat();
    if (switchChat) { syncWorld(); renderAllExits(); }
    refreshSaveName();
    toastr.success(`Saved world "${r.body.name}"${switchChat ? '; this chat now uses it' : ''}.`);
    return { ok: true, world: r.body };
}

/** Rebuild everything from this chat's stamps (same as on chat load). */
async function rebuildFromChat() {
    if (!isOn()) return;
    pendingLocation = null;
    // Resolve the chat's world BEFORE any room request: learn the default world, stamp a new chat's world from the
    // current setting (read fresh), then fetch.
    rememberWorlds((await api('/worlds').catch(() => null))?.body); // also rescans the server's worlds folder
    const cw = chatWorld()?.id;
    if (cw && listedWorlds.size && !listedWorlds.has(cw)) worldMissing(cw);
    await ensureStartStamp();
    syncWorld();
    if (ctx().chat?.length) await warmRooms(chatAddresses()); // one request for every room this chat needs (none if all remembered)
    await applyFacts(); setTimeout(renderAllExits, 0);
}
/** Entry in SillyTavern's Extensions (wand) menu that toggles the current chat; its text follows the state. */
export const wandText = () => (isOn() ? 'Disable WorldScrawl for this chat' : 'Enable WorldScrawl for this chat');
function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('worldscrawl_wand')) return;
    const item = document.createElement('div');
    item.id = 'worldscrawl_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-map extensionsMenuExtensionButton"></div><span></span>';
    item.addEventListener('click', () => setEnabled(!isOn()));
    menu.appendChild(item);
    updateWandItem();
}
function updateWandItem() { const t = document.querySelector('#worldscrawl_wand span'); if (t) t.textContent = wandText(); }
/** Apply this chat's on/off state: off clears every injection and footer; on rebuilds exactly as on chat load. */
async function applyChatState() {
    const box = document.getElementById('worldscrawl_enabled'); if (box) box.checked = isOn();
    updateWandItem(); refreshSaveName();
    applyTools(); applyNudge();
    if (!isOn()) { const c = ctx(); for (const [k, d] of [[NUDGE_KEY, 1], [FACTS_KEY, 1], [REMINDER_KEY, 0]]) c.setExtensionPrompt(k, '', 1, d, false, 0); await renderAllExits(); }
    else await rebuildFromChat();
}
/** Turn WorldScrawl on/off for the current chat (saved in its metadata), without reloading. */
export async function setEnabled(on) {
    const c = ctx();
    if (c.chatMetadata) { c.chatMetadata[ENABLED_KEY] = !!on; (c.saveMetadataDebounced ?? c.saveMetadata)?.(); }
    await applyChatState();
    return on ? 'WorldScrawl is on in this chat.' : 'WorldScrawl is off in this chat.';
}
const whenOn = fn => async (...a) => { if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; } return fn(...a); };

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-go',
        callback: whenOn((_args, dir) => goAction(String(dir ?? '').trim())),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction, e.g. north', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: move through an exit or to a known place, then the model narrates the arrival.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-change',
        callback: whenOn(async (_args, note) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && chat[id]?.is_system && !chat[id]?.extra?.worldscrawl_notice) id--;
            const t = await flagMessage(id, { note: String(note ?? '').trim(), source: 'command' });
            toastr.info(`WorldScrawl: ${t}`); return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'what changed, e.g. "the inn burned down" (optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: 'WorldScrawl: the map changed in the latest message (fire, collapse, smashed door...). The engine works out the change and shows an Approve / Discard card.',
    }));
    for (const sleep of [false, true]) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: sleep ? 'ws-sleep' : 'ws-wait',
        callback: async (_n, arg) => waitCommand(String(arg ?? ''), sleep),
        helpString: sleep ? 'WorldScrawl: sleep here (default 8h): /ws-sleep, /ws-sleep 6h, /ws-sleep until morning. Time passes without moving; delete the message to undo.'
            : 'WorldScrawl: wait here: /ws-wait 2h, /ws-wait 1h30m, /ws-wait 2d, /ws-wait until dawn|morning|noon|dusk|evening|night|midnight|14:30. Delete the message to undo.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'how long, or "until <time>"', typeList: [ARGUMENT_TYPE.STRING], isRequired: !sleep })],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-help', callback: async () => { await addNotice({ kind: 'text', text: helpText() }); return ''; }, helpString: 'WorldScrawl: list the commands ([move], [look], ... and their slash commands). Answered here; the narrator is not called.' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-npc',
        callback: whenOn(async (_a, name) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && chat[id]?.is_system) id--;
            const msg = chat[id];
            if (!msg) { toastr.info('WorldScrawl: open a chat first.'); return ''; }
            await offerRemember(msg, String(name ?? ''));
            return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'the person to remember, e.g. Maren', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: 'WorldScrawl: remember a person (no name: the person the narrator flagged most recently) from the story (an Approve / Adjust / Discard card). A no lasts until the scene changes.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-map', callback: async () => { openMapWindow(); return ''; }, helpString: 'WorldScrawl: open the map window (a new tab that follows this chat live).' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-on', callback: async () => { const t = await setEnabled(true); toastr.info(t); return t; }, helpString: 'WorldScrawl: turn WorldScrawl on in this chat.' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-off', callback: async () => { const t = await setEnabled(false); toastr.info(t); return t; }, helpString: 'WorldScrawl: turn WorldScrawl off in this chat (as if uninstalled; nothing already stamped is changed).' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-dig', callback: whenOn((a, v) => digAction(String(v ?? ''), { oneway: String(a?.oneway ?? 'false') === 'true' })),
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'oneway', description: 'only the exit from here, no way back (default false)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' })],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'dir[/returndir] and a known place, or "new <name>[: description]", e.g. north Village Square, hole/back new Dusty Cellar', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: open a new two-way passage from the current room to a known place or a new room (return name: the opposite direction, else "back"; oneway=true for one-way). Delete the system message to undo.',
    }));
    for (const kind of ['open', 'close']) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: `ws-${kind}`, callback: whenOn((_a, v) => doorAction(kind, String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: `WorldScrawl: ${kind} a door here (both sides; delete the system message to undo).`,
    }));
    for (const kind of ['bar', 'unbar']) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: `ws-${kind}`, callback: whenOn((_a, v) => barAction(kind, String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction (optional when there is one barred door here)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: `WorldScrawl: ${kind} a door from the side its bar is on (delete the system message to undo).`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-removeexit', callback: whenOn((_a, v) => removeExitAction(String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: remove an exit from the current room (delete the system message to undo).',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-save-world',
        callback: whenOn(async (args, v) => {
            let name = String(v ?? '');
            const flag = /(^|\s)--knowledge(\s|$)/.test(name);
            name = name.replace(/(^|\s)--knowledge(?=\s|$)/g, ' ').trim();
            const r = await saveWorld(name, String(args?.switch ?? 'true') !== 'false', flag || String(args?.knowledge ?? 'false') === 'true', { overwrite: String(args?.overwrite ?? 'false') === 'true' });
            return r.ok ? r.world.id : '';
        }),
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'overwrite', description: 'save over another existing living world with this name (default false)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            SlashCommandNamedArgument.fromProps({ name: 'knowledge', description: 'also save what this chat knows (places, revealed doors, location) for new chats; default false (pristine)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),SlashCommandNamedArgument.fromProps({ name: 'switch', description: 'move this chat onto the new world (default true)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'true' })],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'world name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: save this chat\'s world (with its dug/removed exits) as a new world; switch=false keeps the chat on its current world; --knowledge (or knowledge=true) also saves what this chat knows.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-exits',
        callback: whenOn(async () => { try { const t = exitsText(await currentLocation()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        helpString: 'WorldScrawl: show the exits from the current location.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-reveal',
        callback: whenOn(async (_args, what) => { try { const t = await revealPlaces(String(what ?? '').trim()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'all | region | subregion | <place, subregion or region id> | off', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: mark places as visited so you can travel there: all (the whole world), region or subregion (the current one), or an id. "off" turns the latest reveal off. Stamped on a small message (delete it to undo).',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-known',
        callback: whenOn(async () => { try { const t = await knownText(); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        helpString: 'WorldScrawl: list the places this chat knows: where you have been, and places seen but not visited.',
    }));
}

const REVEAL_KEY = 'worldscrawl_reveal';
/** Which addresses a /ws-reveal scope covers, out of the effective map's addresses. */
export function revealScope(what, addresses, here) {
    const w = String(what ?? '').trim();
    if (!w) throw new Error('Say what to reveal: all, region, subregion, or an id.');
    const [reg, rest = ''] = String(here ?? '').split(':'), sub = rest.split('/')[0];
    if (w === 'all') return [...addresses];
    if (w === 'region') return addresses.filter(a => a.startsWith(`${reg}:`));
    if (w === 'subregion') return addresses.filter(a => a.startsWith(`${reg}:${sub}/`));
    if (addresses.includes(w)) return [w];
    const pre = w.includes(':') ? `${w}/` : `${w}:`;
    return addresses.filter(a => a.startsWith(pre));
}
/** /ws-reveal: stamp places as been-there (stateless; delete the message or "/ws-reveal off" to undo). */
export async function revealPlaces(what) {
    const c = ctx(), chat = c.chat ?? [];
    if (what === 'off') {
        for (let i = chat.length - 1; i >= 0; i--) { const rv = chat[i]?.extra?.[REVEAL_KEY]; if (rv && rv.off !== true) { rv.off = true; syncSwipeExtra?.(chat[i]); await c.saveChat?.(); await afterReveal(); return `WorldScrawl: turned off the reveal from #${i}.`; } }
        return 'WorldScrawl: no reveal to turn off.';
    }
    const idx = await api('/inspect/index', { method: 'POST', body: JSON.stringify(mapCtx()) });
    if (!idx.ok) throw new Error(`WorldScrawl: couldn't read the map (${idx.status}).`);
    const here = (await currentLocation().catch(() => null))?.address ?? getStoredLocation();
    const addresses = revealScope(what, idx.body.addresses ?? [], here);
    if (!addresses.length) throw new Error(`WorldScrawl: nothing matches "${what}".`);
    const text = `Map: revealed ${addresses.length} place${addresses.length === 1 ? '' : 's'} (${what}).`;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text, extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'reveal', [REVEAL_KEY]: { scope: what, addresses } } };
    chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    await afterReveal();
    return text;
}
async function afterReveal() { renderAllExits?.(); broadcastMapState(); }
globalThis.worldscrawlReveal = revealPlaces;

/** Read-only summary of this chat's knowledge (hidden-exit destinations never included: discoveredPlaces filters them). */
export async function knownText() {
    const stood = new Set(await stoodInAddresses());
    const known = await discoveredPlaces();
    const name = p => p.display_name || p.name || p.address;
    const been = [...known.values()].filter(p => stood.has(p.address)).map(name);
    const seen = [...known.values()].filter(p => !stood.has(p.address)).map(name);
    return `Been there: ${been.join(', ') || 'nowhere yet'}. Seen: ${seen.join(', ') || 'nothing else'}.`;
}

// ---- Exits footer: display-only (DOM), never written into message.mes, so the model never sees it.
const exitsCache = new Map(); // "world|address" -> Promise<location|null> (never shared between worlds)
/** Cache key: the world the request goes to plus the address ("(start)" for the start room). */
const ck = (a, w = activeWorld || defaultWorldId || '', sig = patchSig()) => `${w}|${sig}${a ?? '(start)'}`;

/** /move returns the full new location: remember it so the next lookup needs no request. */
function primeCache(loc, w) { if (loc?.room_token) roomTokens.set(loc.address, loc.room_token); const k = ck(loc?.address, w); if (loc?.address && !exitsCache.has(k)) exitsCache.set(k, Promise.resolve(loc)); }

/**
 * Make sure these rooms (and the start room) are remembered, fetching all missing ones in ONE request
 * (GET /rooms). Used when rebuilding after a reload, instead of one /location request per room.
 */
function warmRooms(addresses) {
    const w = activeWorld || defaultWorldId || '';
    const missing = [...new Set(addresses)].filter(a => a && !exitsCache.has(ck(a, w)));
    const needStart = !exitsCache.has(ck(null, w));
    if (!missing.length) return needStart ? fetchLocationCached(null) : Promise.resolve();
    const batch = (async () => {
        try { const r = patchSig() ? await api('/rooms', { method: 'POST', body: JSON.stringify({ addresses: missing, ...mapCtx() }) }) : await api(`/rooms?addresses=${encodeURIComponent(missing.join(','))}`); return r.ok ? r.body : null; } catch { return null; }
    })();
    const remember = (key, p) => { exitsCache.set(key, p); p.then(v => { if (v?.room_token) roomTokens.set(v.address, v.room_token); if (!v && exitsCache.get(key) === p) exitsCache.delete(key); }); };
    for (const a of missing) remember(ck(a, w), batch.then(b => b?.rooms?.find(x => x.address === a) ?? null));
    if (needStart) remember(ck(null, w), batch.then(b => { if (b?.start) primeCache(b.start, w); return b?.start ?? null; }));
    return batch;
}

function fetchLocationCached(address) { return fetchRaw(address).then(l => { if (l?.room_token) roomTokens.set(l.address, l.room_token); return l ?? newRoom(address); }).then(applyReveals).then(applyChanges); }
/** A room this chat created (add_room change), built locally: the server only knows it per request (with changes). */
async function newRoom(address) {
    const ch = address && chatChanges().find(c => c.type === 'add_room' && c.address === address);
    if (!ch) return null;
    const near = ch.from ? await fetchRaw(ch.from) : null;
    const sub = near?.subregion ?? {};
    return { address, name: ch.name, display_name: placeLabel(ch.name, sub.name), description: ch.description, exits: [],
        region: near?.region ?? {}, subregion: sub, effective_notes: near?.effective_notes ?? {}, new_room: true };
}
function fetchRaw(address) {
    const w = activeWorld || defaultWorldId || '';
    const key = ck(address, w);
    if (!exitsCache.has(key)) {
        const p = (async () => {
            try {
                if (patchSig()) { // this chat changed the map: rooms come from the patched world
                    const r = await api('/rooms', { method: 'POST', body: JSON.stringify({ addresses: address ? [address] : [], ...mapCtx() }) });
                    return r.ok ? (address ? r.body.rooms?.[0] ?? null : r.body.start) : null;
                }
                const r = await api(address ? `/location/${encodeURIComponent(address)}` : '/start');
                if (r.ok && !address) primeCache(r.body, w);
                return r.ok ? r.body : null;
            } catch { return null; }
        })();
        p.then(v => { if (v?.room_token) roomTokens.set(v.address, v.room_token); if (!v) exitsCache.delete(key); }); // don't cache failures (server down)
        exitsCache.set(key, p);
    }
    return exitsCache.get(key);
}

/** The player's location in effect at message `id`: latest stamp at or before it, else null (= start). */
function locationAt(id, actor = PLAYER) {
    const chat = ctx().chat ?? [];
    const p = positionOf(chat, id, actor);
    return p ? relocateFrom(p.address, p.index, chat.slice(0, id + 1)) : null;
}

export function exitsText(loc) {
    const exits = loc?.exits ?? [];
    return 'Exits: ' + (exits.length ? exitLabels(exits).join(', ') : 'none');
}

async function renderExits(id) {
    if (!isOn()) return;
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
    if (isLast) { await loadCalendar(); const d = gameDate(ch.slice(0, id + 1)); if (d) { const t = document.createElement('div'); t.className = 'worldscrawl_clock'; const wx = placeWeatherNow(loc, ch.slice(0, id + 1)); t.textContent = calendarLib.shortDate(d) + (wx?.short ? ` · ${wx.short}` : ''); div.appendChild(t); } }
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
        if (msg.extra.worldscrawl_notice_kind === 'missing_world') {
            const ws = msg.extra[WORLD_KEY] ? [] : msg.extra.worldscrawl_notice_worlds ?? [];
            if (!ws.length) { if (text.querySelector('.worldscrawl_exit')) text.textContent = msg.mes; continue; }
            text.textContent = '';
            text.append(msg.extra.worldscrawl_notice_prefix + ' ');
            ws.forEach((w, i) => { if (i) text.append(', '); const b = makeButton(w.name, `Move this chat to ${w.name}`, () => moveChatToWorld(w.id, id)); b.classList.add('worldscrawl_world_button'); b.dataset.world = w.id; text.appendChild(b); });
            text.append(']');
            continue;
        }
        if (msg.extra.worldscrawl_notice_kind === 'text') continue;
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

// ---- "Start your adventure": a [ws-start] marker in the greeting becomes a button (display only; message text untouched).
export const START_MARKER = '[ws-start]';
function renderStartButton() {
    const el = document.querySelector('#chat .mes[mesid="0"] .mes_text');
    if (!el) return;
    const active = isOn() && (ctx().chat?.length ?? 0) <= 1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; for (let n; (n = walker.nextNode());) if (n.nodeValue.includes(START_MARKER)) nodes.push(n);
    for (const n of nodes) {
        const parts = n.nodeValue.split(START_MARKER);
        const frag = document.createDocumentFragment();
        parts.forEach((t, i) => {
            if (i) { const b = document.createElement('span'); b.className = 'worldscrawl_start'; frag.appendChild(b); }
            if (t) frag.append(t);
        });
        n.replaceWith(frag);
    }
    for (const b of el.querySelectorAll('.worldscrawl_start')) {
        b.textContent = '';
        if (!active) { b.style.display = 'none'; continue; }
        b.style.display = '';
        const btn = makeButton('Start your adventure', 'Send "I look around"', startAdventure);
        btn.classList.add('worldscrawl_start_button', 'menu_button');
        btn.style.cssText = 'cursor:pointer;display:inline-block;width:auto;white-space:nowrap;padding:4px 10px;';
        b.appendChild(btn);
    }
}
function startAdventure() {
    if ((ctx().chat?.length ?? 0) > 1) return renderStartButton();
    const ta = document.getElementById('send_textarea');
    ta.value = 'I look around';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send_but')?.click();
}

/** Game-time labels on every narrator message: live from clockAt, never stored. */
async function renderTimeLabels() {
    document.querySelectorAll('#chat .worldscrawl_time').forEach(e => e.remove());
    if (!isOn() || settings().showTimes === false) return;
    await loadCalendar();
    const chat = ctx().chat ?? [], t = worldTimes.get(activeWorld || defaultWorldId);
    if (!calendarLib || !t || !chat.length) return;
    let startDay;
    try { startDay = calendarLib.dateAt(0, t.start_date, t.calendar).day_number; } catch { return; }
    const hpd = t.calendar?.hours_per_day ?? 24;
    const date = s => calendarLib.dateAt(s, t.start_date, t.calendar);
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const i = Number(el.getAttribute('mesid'));
        let l = null; try { l = timeLabel(chat, i, { clock: j => clockAt(j, chat), date, startDay, hoursPerDay: hpd }); } catch { l = null; }
        if (!l) continue;
        const span = document.createElement('small');
        span.className = 'worldscrawl_time'; span.title = 'Game time at this message (from the waits and moves before it)';
        span.style.cssText = 'opacity:0.7;margin-left:6px;font-style:italic;';
        span.textContent = l.text;
        const host = el.querySelector('.ch_name .flex-container') ?? el.querySelector('.ch_name') ?? el.querySelector('.mes_block') ?? el;
        host.appendChild(span);
    }
}
async function renderAllExits() {
    broadcastMapState();
    renderTimeLabels().catch(e => console.warn('[WorldScrawl] time labels', e));
    renderStartButton();
    if (!isOn()) { // off: strip footers and notice buttons, no server calls
        document.querySelectorAll('#chat .worldscrawl_exits').forEach(e => e.remove());
        for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
            const msg = ctx().chat?.[Number(el.getAttribute('mesid'))];
            const text = el.querySelector('.mes_text');
            if (msg?.extra?.worldscrawl_notice && text?.querySelector('.worldscrawl_exit')) text.textContent = msg.mes;
        }
        return;
    }
    syncWorld();
    if (ctx().chat?.length) await warmRooms(chatAddresses()); // after a reload: one batch request instead of one per message
    await syncDoors();
    renderNotices();
    renderPatchCards();
    document.querySelectorAll('#chat .worldscrawl_exits').forEach(e => e.remove());
    if (!settings().showExits) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderExits(el.getAttribute('mesid')));
}

// ---- The WorldScrawl window (plugin/ui/, served by the plugin). Same origin, so it hears this tab over a
// BroadcastChannel: every state change is posted, and a window that opens asks with 'hello'.
export const MAP_URL = `${PLUGIN_URL}/ui/`;
const THEME_VARS = ['--SmartThemeBodyColor', '--SmartThemeEmColor', '--SmartThemeUnderlineColor', '--SmartThemeQuoteColor', '--SmartThemeBlurTintColor',
    '--SmartThemeChatTintColor', '--SmartThemeUserMesBlurTintColor', '--SmartThemeBotMesBlurTintColor', '--SmartThemeShadowColor', '--SmartThemeBorderColor', '--mainFontFamily'];
export function themeVars(el = document.documentElement) {
    const cs = getComputedStyle(el), out = {};
    for (const k of THEME_VARS) { const v = cs.getPropertyValue(k).trim(); if (v) out[k] = v; }
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)') out['--ws-bg'] = bg;
    if (out['--mainFontFamily']) out['--ws-font'] = out['--mainFontFamily'];
    return out;
}
let mapChannel = null;
/** The state the map window shows: this chat's world, where the player is (the party marker), what it knows, open doors and changes. */
export async function mapState() {
    const c = ctx();
    const base = { type: 'state', chatId: c.chatId ?? c.getCurrentChatId?.() ?? null, chatName: c.name2 ?? '', theme: themeVars(), showEditMessages: !!settings().showEditMessages };
    if (!isOn() || !base.chatId) return { ...base, on: false };
    syncWorld();
    const stood = [...await stoodInAddresses()];
    const seen = [...(await discoveredPlaces()).keys()].filter(a => !stood.includes(a));
    const here = await currentLocation();
    return { ...base, on: true, world: activeWorld || defaultWorldId || '', worldName: worldName(activeWorld), map_version: mapVersion,
        clock: (await loadCalendar()) && gameDate() ? calendarLib.shortDate(gameDate()) : '',
        weather: here ? placeWeatherNow(here)?.short ?? '' : '',
        abs_seconds: (() => { try { const t = worldTimes.get(activeWorld || defaultWorldId), d = gameDate(); return weatherLib && t && d ? weatherLib.absSeconds(d, t.calendar) : null; } catch { return null; } })(),
        last_wait: (() => { const ch = c.chat ?? []; for (let i = ch.length - 1; i >= 0; i--) { const w = ch[i]?.extra?.[WAIT_KEY]; if (w?.seconds > 0) return { msg: i, label: w.label, sleep: !!w.sleep, recent: i >= lastUserIndex(ch) }; } return null; })(),
        location: here?.address ?? null, positions: here?.address ? { [PLAYER]: here.address } : {}, stood, seen, doors_revealed: [...revealedDoors], doors_open: [...doorStates().keys()], doors_closed: [...doorOverrides()].filter(([, c]) => c.type === 'close_door').map(([d]) => d), npcs: mapNpcs(c.chat, here), npc_inspect: mapInspect(c.chat, here), activity: mapActivity(c.chat, here), last_msg: (c.chat?.length ?? 0) - 1, last_swipe: c.chat?.length ? swipeOf(c.chat[c.chat.length - 1]) ?? null : null, ...mapCtx() };
}
let broadcastTimer = null;
export function broadcastMapState() {
    if (typeof BroadcastChannel === 'undefined') return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(async () => {
        try { mapChannel ??= openMapChannel(); mapChannel.postMessage(await mapState()); } catch (e) { console.warn('[WorldScrawl] map broadcast failed', e); }
    }, 150);
}
export const expandSys = () => P('expand.system', { reply: baseReply('text') });
function openMapChannel() {
    const ch = new BroadcastChannel('worldscrawl');
    ch.addEventListener('message', ev => {
        if (ev.data?.type === 'hello') broadcastMapState();
        if (ev.data?.type === 'set_debug' && ev.data.key === 'showEditMessages') { // the map's Debug menu toggle
            settings().showEditMessages = !!ev.data.value; ctx().saveSettingsDebounced?.(); renderPatchCards(); broadcastMapState();
        }
        if (ev.data?.type === 'reveal') { // the map's Debug > Reveal map: the same as /ws-reveal (the map asked to confirm)
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) revealPlaces(String(d.what ?? 'all'))
                .then(t => { toastr.info(t); ch.postMessage({ type: 'reveal_result', req: d.req, ok: true, text: t }); })
                .catch(e => { toastr.error(e.message); ch.postMessage({ type: 'reveal_result', req: d.req, ok: false, error: e.message }); });
        }
        if (ev.data?.type === 'prompts_changed') ensurePrompts(true).catch(e => console.warn('[WorldScrawl]', e.message)); // the Prompt Editor saved
        // The map's Wait button: only the tab showing that chat acts on it (the map never changes state itself).
        if (ev.data?.type === 'patch') { // the map's "Edit live": this tab stamps it on a hidden message and answers
            const c = ctx();
            if (ev.data.chatId && ev.data.chatId === (c.chatId ?? c.getCurrentChatId?.())) liveEdit(Array.isArray(ev.data.ops) ? ev.data.ops : [], String(ev.data.note ?? ''))
                .then(r => ch.postMessage({ type: 'patch_result', req: ev.data.req, ...r }))
                .catch(e => ch.postMessage({ type: 'patch_result', req: ev.data.req, ok: false, errors: [{ i: null, error: e.message }] }));
        }
        if (ev.data?.type === 'toggle_change') { // the inspector's Turn off / Turn on: same flow as the cards; the map asks to confirm
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) toggleChange(Number(d.msg), String(d.id ?? ''), { choice: d.choice })
                .then(r => ch.postMessage({ type: 'toggle_result', req: d.req, ...r }))
                .catch(e => ch.postMessage({ type: 'toggle_result', req: d.req, ok: false, error: e.message }));
        }
        if (ev.data?.type === 'remove_change') { // the inspector's Undo of one change
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) removeChange(Number(d.msg), String(d.id ?? ''), { choice: d.choice })
                .then(r => ch.postMessage({ type: 'remove_result', req: d.req, ...r }))
                .catch(e => ch.postMessage({ type: 'remove_result', req: d.req, ok: false, error: e.message }));
        }
        if (ev.data?.type === 'expand') { // the map's "Expand with AI": one model call with the map-built prompt (parent notes and neighbors only)
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) ensurePrompts().then(() => gen('map expand', { prompt: String(d.prompt ?? ''), systemPrompt: expandSys(), responseLength: 300 }))
                .then(t => ch.postMessage({ type: 'expand_result', req: d.req, ok: true, text: String(t ?? '').trim() }))
                .catch(e => ch.postMessage({ type: 'expand_result', req: d.req, ok: false, error: e.message }));
        }
        if (ev.data?.type === 'change_open' || ev.data?.type === 'change_save') { // the map editor tab for one kept change
            const d = ev.data, bad = changeEditMismatch(d.session);
            const reply = r => ch.postMessage({ type: `${d.type}_result`, req: d.req, ...r });
            if (bad) { if (d.type === 'change_save') toastr.warning(`WorldScrawl: edit not saved. ${bad}`); reply({ ok: false, errors: [{ i: null, error: bad }], stale: true }); }
            else (d.type === 'change_open' ? changeEditSession(d.session) : restampChange(Number(d.session.msg), d.session.change, Array.isArray(d.ops) ? d.ops : []))
                .then(r => reply({ ...r, ...(r.ok && d.type === 'change_save' ? { hash: opsHash((ctx().chat[Number(d.session.msg)].extra?.[PATCH_KEY] ?? []).find(x => x.id === d.session.change)?.ops) } : {}) }))
                .catch(e => reply({ ok: false, errors: [{ i: null, error: e.message }] }));
        }
        // The cast browser: Update <name> / Export from the in-play view, a cast file saved or deleted, and a message link.
        if (ev.data?.type === 'npc_export') {
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) exportNpc(String(d.id ?? ''), { update: d.update === true })
                .then(r => ch.postMessage({ type: 'npc_export_result', req: d.req, ...(r ?? { ok: false, error: 'not in this chat' }) }))
                .catch(e => ch.postMessage({ type: 'npc_export_result', req: d.req, ok: false, error: e.message }));
        }
        if (ev.data?.type === 'npc_chat_edit') {
            const d = ev.data;
            npcChatEdit(d).then(r => ch.postMessage({ type: 'npc_chat_edit_result', req: d.req, ...r })).catch(e => ch.postMessage({ type: 'npc_chat_edit_result', req: d.req, ok: false, error: e.message }));
        }
        if (ev.data?.type === 'cast_changed') api('/worlds').then(r => { rememberWorlds(r?.body); broadcastMapState(); }).catch(() => {});
        if (ev.data?.type === 'show_message') {
            const c = ctx(), d = ev.data;
            if (d.chatId && d.chatId === (c.chatId ?? c.getCurrentChatId?.())) {
                const el = document.querySelector(`#chat .mes[mesid="${Number(d.msg)}"]`);
                if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--SmartThemeQuoteColor)'; setTimeout(() => { el.style.outline = ''; }, 1500); window.focus?.(); }
                else toastr.info(`WorldScrawl: message #${Number(d.msg)} is not loaded in the chat.`);
            }
        }
        if (ev.data?.type === 'wait') { const c = ctx(); if (ev.data.chatId && ev.data.chatId === (c.chatId ?? c.getCurrentChatId?.())) waitCommand(String(ev.data.args ?? ''), !!ev.data.sleep); }
    });
    return ch;
}
export function openMapWindow() {
    const w = window.open(MAP_URL, 'worldscrawl_map');
    if (!w) toastr.warning(`Your browser blocked the pop-up. Open ${location.origin}${MAP_URL} in a new tab.`);
    setTimeout(broadcastMapState, 1000);
    return MAP_URL;
}

async function testConnection() {
    const status = document.getElementById('worldscrawl_status');
    status.textContent = 'Testing...';
    try {
        const r = await api('/health');
        const tools = ctx().isToolCallingSupported() ? 'function calling is ON' : 'function calling is OFF or not supported by the current API/model';
        status.textContent = r.ok ? `Connected: ${r.body.locations} locations, start ${r.body.start}. Current: ${getStoredLocation() ?? '(start)'}. ${tools}.` : r.status === 404 && baseUrl() === PLUGIN_URL ? `Not found (404). ${NOT_RUNNING()}` : `Server error ${r.status}${r.body?.detail && typeof r.body.detail === 'string' ? `: ${r.body.detail}` : ''}`;
    } catch (e) {
        status.textContent = e.message;
    }
}

async function fillWorlds() {
    const sel = document.getElementById('worldscrawl_world');
    if (!sel) return;
    const r = await api('/worlds').catch(() => null);
    rememberWorlds(r?.body);
    refreshSaveName();
    sel.innerHTML = '<option value="">(server default)</option>';
    for (const w of r?.body?.worlds ?? []) { const o = document.createElement('option'); o.value = w.id; o.textContent = w.name; sel.appendChild(o); }
    if (settings().world && r?.body?.worlds && !listedWorlds.has(settings().world)) { // picked world was deleted
        toastr.info(`WorldScrawl: the world for new chats is gone; using ${worldName(defaultWorldId)}.`);
        settings().world = ''; ctx().saveSettingsDebounced();
    }
    sel.value = settings().world ?? '';
}
/** Open the worlds folder (no id) or one world's folder in the system file browser (the server opens it). */
export async function openWorldFolder(id = '') {
    const r = await api(`/open-folder${id ? `?world=${encodeURIComponent(id)}` : ''}`, { method: 'POST', body: '{}' });
    if (!r.ok) toastr.warning(typeof r.body?.detail === 'string' ? r.body.detail : r.body?.detail?.message ?? 'Could not open the folder.');
    return r.ok;
}

// ---- Map patches: lasting changes to places (a fire, a collapse, a smashed door). A patch is stamped on the message
// where the change settled (PATCH_KEY, per swipe); the server applies the stamped patches to the world per request
// (plugin/ui/patches.mjs), world files are never written, and deleting the message undoes the patch. Triggers: the
// flag button on a message, the ws_flag tool, a [ws_flag: place | what changed] tag in a reply, and /ws-change.
export const flagHint = (on = proactiveDiscovery()) => P('narration.flag_hint', { discover: P(on ? 'narration.discover_proactive' : 'narration.discover_strict') });
export const flagToolText = (on = proactiveDiscovery()) => P('narration.flag_tool', { discover: P(on ? 'narration.flag_tool_proactive' : 'narration.flag_tool_strict') });
export const flagActionText = (on = proactiveDiscovery()) => P('narration.flag_action', { discover: P(on ? 'narration.flag_action_proactive' : 'narration.flag_action_strict') });
export const waitHint = () => P('narration.wait_hint');
const FLAG_TAG = /\[ws_flag:\s*([^\]]{0,300})\]/i;
let pendingWait = null; // from ws_flag action wait/sleep: stamped on the reply when it arrives
const RANGE_CAP = 10;
let pendingNameFlags = []; // names from ws_flag action name: the player learned them; stamped on the reply
let pendingNpcFlags = []; // names from ws_flag action npc: stamped on the reply when it arrives
let pendingLoreFlags = []; // places from ws_flag action lore: stamped on the reply when it arrives
let pendingFlag = null; // from the ws_flag tool: attached to the reply when it arrives
let patchLib = null;
const swipeOf = m => m?.swipe_id ?? 0;
/** The patches on a message that belong to the swipe being shown. */
export const patchesOn = m => (m?.extra?.[PATCH_KEY] ?? []).filter(p => (p?.swipe ?? 0) === swipeOf(m));
/** A location stamped on message i, after any later patch merged or removed that room. */
function relocateFrom(addr, i, chat) {
    // Expired temporary patches ("lasts") no longer redirect (#47); the resolver handles any room that is still missing.
    const now = patchLib ? chatElapsed(chat) : null;
    const live = p => p?.off !== true && (!patchLib || patchLib.activeChanges([p], now).length > 0);
    for (let j = i; j < chat.length; j++) for (const p of patchesOn(chat[j]).filter(live)) if (p?.relocate && Object.hasOwn(p.relocate, addr)) addr = p.relocate[addr];
    return addr;
}
/** Changes plus the game clock: every map request carries both (patch ops with "lasts" expire on the clock). */
function mapCtx() { return { changes: chatChanges(), now: chatElapsed() }; }
/** Short signature of the active patches ('' when none): part of the room cache key. */
function patchSig() {
    const chat = ctx().chat ?? [];
    if (!chat.some(m => m?.extra?.[PATCH_KEY])) return '';
    let ps = chatChanges(chat).filter(c => c.type === 'patch' && c.off !== true);
    if (patchLib && ps.length) ps = patchLib.activeChanges(ps, chatElapsed(chat));
    if (!ps.length) return '';
    const s = JSON.stringify(ps.map(p => [p.id, p._msg, p.ops.length]));
    let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `p${h.toString(36)}|`;
}
let formLib = null;
async function loadFormLib() { try { formLib ??= await import(`${baseUrl()}/ui/patchform.mjs`); } catch (e) { console.warn('[WorldScrawl] patch form unavailable:', e.message); } return formLib; }
let formRooms = null;
/** Addresses and area ids for the editor's suggestions (cached per map version). */
async function formChoices() {
    if (formRooms?.v === mapVersion && formRooms.list) return formRooms.list;
    const r = await api('/inspect/index', { method: 'POST', body: JSON.stringify(mapCtx()) });
    const rooms = r.ok ? r.body.addresses ?? [] : [];
    const areas = [...new Set(rooms.flatMap(a => { const ar = a.split('/')[0]; return [ar, ar.split(':')[0]]; }))];
    formRooms = { v: mapVersion, list: { rooms, areas, names: r.ok ? r.body.names ?? {} : {}, areaNames: r.ok ? r.body.areaNames ?? {} : {} } };
    return formRooms.list;
}
/** Check edited ops against the map (changes = the chat's changes the patch sits on). Returns {ok, preview} or {ok:false, error, at}. */
export async function previewOps(ops, ctxOver = mapCtx()) {
    const fl = await loadFormLib();
    const local = fl ? fl.checkOps(ops) : [];
    if (local.length) return { ok: false, errors: local };
    const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops }, ...ctxOver }) });
    if (r.ok) return { ok: true, preview: r.body };
    const msg = r.body?.detail?.error ?? (typeof r.body?.detail === 'string' ? r.body.detail : `server error ${r.status}`);
    return { ok: false, errors: [fl ? fl.errorsByOp(msg) : { i: null, error: msg }] };
}
let diffLib = null;
async function loadDiffLib() { try { diffLib ??= await import(`${baseUrl()}/ui/diffview.mjs`); } catch (e) { console.warn('[WorldScrawl] diff view unavailable:', e.message); } return diffLib; }
/** The red/green before/after view of a preview ({before, after, ops, relocate}) into `box`. */
async function drawDiff(box, pv) {
    const dl = await loadDiffLib();
    if (!dl) { box.textContent = ''; return; }
    box.replaceChildren(dl.renderDiff(document, { before: pv.before ?? {}, after: pv.after ?? {}, ops: pv.ops ?? [], relocate: pv.relocate ?? {}, inherit: pv.inherit ?? {}, names: pv.names ?? {} }));
}
/** Re-preview edited ops (debounced) and redraw the diff: the view follows the form while you type. */
const liveTimers = new WeakMap();
function liveDiff(box0, ops, ctxOver, form = null) {
    const key = form ?? box0;
    if (form) form.diffBox = box0;
    clearTimeout(liveTimers.get(key));
    liveTimers.set(key, setTimeout(async () => {
        const box = form?.diffBox ?? box0; // cards re-render: always draw into the current box
        if (!box.isConnected) return;
        const r = await previewOps(ops, { ...mapCtx(), ...ctxOver });
        if (!r.ok) { box.style.opacity = '0.5'; box.title = 'Fix the form to update this view'; return; }
        box.style.opacity = ''; box.title = '';
        form?.setNoops?.(r.preview.noops ?? []);
        if (form) form.lastPreview = r.preview;
        await drawDiff(form?.diffBox ?? box, r.preview);
    }, 350));
}
/** Open editors on cards, kept across re-renders: key "<msg>|flag" or "<msg>|<patch id>". */
const openForms = new Map();
async function openEditor(key, ops, context = {}) {
    const fl = await loadFormLib();
    if (!fl) { toastr.error('WorldScrawl: the change editor could not load. Restart SillyTavern after updating.'); return; }
    const ch = await formChoices();
    let form = null;
    form = fl.buildPatchForm(document, { ops, rooms: ch.rooms, areas: ch.areas, names: ch.names, areaNames: ch.areaNames, context, onChange: o => { form?.onLive?.(o); } });
    openForms.set(key, form);
    renderPatchCards();
}
/** Re-stamp a kept change with edited ops (same message, same id); the rest of the chat's changes must still fit. */
async function saveKeptEdit(id, pid, form) {
    const r = await restampChange(id, pid, form.getOps());
    if (!r.ok) { form.setErrors(r.errors); return; }
    openForms.delete(`${id}|${pid}`);
    renderPatchCards();
}
/** {ok, summary} or {ok:false, errors}. Shared by the in-chat editor and the map editor tab. */
export async function restampChange(id, pid, ops) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], p = (msg?.extra?.[PATCH_KEY] ?? []).find(x => x.id === pid);
    if (!p) return { ok: false, errors: [{ i: null, error: 'That change is no longer on its message.' }] };
    const before = chatChanges(chat.slice(0, id));
    const r = await previewOps(ops, { changes: before, now: chatElapsed(chat.slice(0, id + 1)) });
    if (!r.ok) return { ok: false, errors: r.errors };
    const old = { ops: p.ops, summary: p.summary, relocate: p.relocate, inherit: p.inherit, names: p.names, edited: p.edited };
    Object.assign(p, { ops: r.preview.ops ?? ops, summary: r.preview.summary, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {}, edited: Date.now() });
    const all = await api('/inspect/index', { method: 'POST', body: JSON.stringify(mapCtx()) });
    if (!all.ok) {
        Object.assign(p, old);
        return { ok: false, errors: [{ i: null, error: `A later change no longer fits with this edit: ${all.body?.detail?.error ?? all.status}` }] };
    }
    syncSwipeExtra(msg);
    await c.saveChat?.();
    exitsCache.clear();
    toastr.success('WorldScrawl: change updated.');
    await applyFacts();
    renderAllExits();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, summary: p.summary ?? [] };
}

// ---- Edit in the map editor tab: Edit on a "Map changed here" bar opens plugin/ui/?edit=... in a new tab. The URL names
// the chat, message, swipe, change id and a hash of the change's ops; the tab asks this tab for the change ('change_open')
// and posts the edited ops back ('change_save'). Both are only answered when all of these still match.
export const opsHash = ops => { let h = 5381; for (const ch of JSON.stringify(ops ?? [])) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h.toString(36); };
const currentChatId = () => { const c = ctx(); return c.chatId ?? c.getCurrentChatId?.() ?? null; };
export const changeEditUrl = (id, p, chat = ctx().chat ?? [], chatId = currentChatId()) =>
    `${MAP_URL}?${new URLSearchParams({ edit: '1', chat: String(chatId ?? ''), msg: String(id), swipe: String(chat[id]?.swipe_id ?? 0), change: String(p.id), hash: opsHash(p.ops) })}`;
/** Why an edit session no longer fits this chat ('' = it does). */
export function changeEditMismatch(d, chat = ctx().chat ?? [], chatId = currentChatId()) {
    if (!d || String(d.chat ?? '') !== String(chatId ?? '')) return 'That chat is not the one open in SillyTavern now.';
    const msg = chat[Number(d.msg)];
    if (!msg) return 'That message is no longer in the chat.';
    if (String(msg.swipe_id ?? 0) !== String(d.swipe ?? 0)) return 'That message is showing a different swipe now.';
    const p = patchesOn(msg).find(x => x.id === d.change) ?? (msg.extra?.[PATCH_KEY] ?? []).find(x => x.id === d.change);
    if (!p) return 'That change is no longer on its message.';
    if (opsHash(p.ops) !== d.hash) return 'That change was edited since this editor opened. Close this tab and press Edit again.';
    return '';
}
export function editChangeInTab(id, p, fallback = () => {}) {
    try { mapChannel ??= openMapChannel(); } catch {}
    const w = typeof window !== 'undefined' ? window.open(changeEditUrl(id, p), '_blank') : null;
    if (!w) { toastr.warning('WorldScrawl: the browser blocked the editor tab, so it opens here instead.'); fallback(); }
}
async function changeEditSession(d) {
    const chat = ctx().chat ?? [], id = Number(d.msg), msg = chat[id];
    const p = (msg.extra?.[PATCH_KEY] ?? []).find(x => x.id === d.change);
    const before = chatChanges(chat.slice(0, id));
    return { ok: true, ops: p.ops, summary: p.summary ?? [], note: p.note ?? '', before, with: [...before, { ...p, _msg: id }], now: chatElapsed(chat.slice(0, id + 1)), world: activeWorld || defaultWorldId || '', mes: String(msg.mes ?? '').slice(0, 300) };
}
/** Which kept changes can't apply any more (a change they built on was turned off): [{msg, id, error}], refreshed in the background. */
let changeStatus = { key: null, failed: [], busy: null };
const failedFor = (mi, pid) => changeStatus.failed.find(f => f.msg === mi && f.id === pid);
async function refreshChangeStatus() {
    const body = mapCtx(), key = JSON.stringify(body);
    if (key === changeStatus.key || changeStatus.busy === key) return;
    if (!body.changes.some(c => c?.type === 'patch')) { changeStatus = { key, failed: [], busy: null }; return; }
    changeStatus.busy = key;
    const r = await api('/changes/status', { method: 'POST', body: JSON.stringify(body) }).catch(() => ({ ok: false }));
    if (changeStatus.busy !== key) return;
    changeStatus = { key, failed: r.ok ? r.body.failed ?? [] : [], busy: null };
    renderPatchCards();
}
/** What else depends on kept change (message mi, id pid): {hard, overlaps}, each [{msg, id, note, summary}]. */
export async function changeDependents(mi, pid) {
    const changes = chatChanges(), index = changes.findIndex(x => x._msg === mi && x.id === pid && x.type === 'patch');
    if (index < 0) return { hard: [], overlaps: [] };
    const r = await api('/changes/dependents', { method: 'POST', body: JSON.stringify({ changes, index, now: chatElapsed() }) });
    return r.ok ? { hard: r.body.hard ?? [], overlaps: r.body.overlaps ?? [] } : { hard: [], overlaps: [] };
}
/** Turn a kept change off or on again (retroactively). It stays stored on its message; turned off, the replay skips it.
 *  Turning off with dependents and no `choice` returns {ok:false, confirm:{hard, overlaps}}: ask, then call again with
 *  choice 'all' (also turn those off), 'one' (just this one) or 'cancel'. Posts a hidden note the model doesn't see. */
export async function toggleChange(mi, pid, { choice } = {}) {
    const c = ctx(), chat = c.chat ?? [], find = (i, id) => patchesOn(chat[i]).find(x => x.id === id);
    const p = find(mi, pid);
    if (!p) return { ok: false, error: 'That change is no longer on its message.' };
    const turningOn = p.off === true;
    let others = [];
    if (!turningOn) {
        if (choice === 'cancel') return { ok: false, cancelled: true };
        if (!choice) {
            const deps = await changeDependents(mi, pid);
            if (deps.hard.length || deps.overlaps.length) return { ok: false, confirm: deps };
        } else if (choice === 'all') {
            const deps = await changeDependents(mi, pid);
            others = [...deps.hard, ...deps.overlaps].filter(d => d.msg != null && find(d.msg, d.id) && !find(d.msg, d.id).off);
        }
    }
    for (const [i, id] of [[mi, pid], ...others.map(d => [d.msg, d.id])]) {
        const q = find(i, id);
        if (turningOn) delete q.off; else q.off = true;
        syncSwipeExtra(chat[i]);
    }
    const also = [...new Set(others.map(d => d.msg))].filter(i => i !== mi);
    const text = `Map edit: turned ${turningOn ? 'on' : 'off'} the change from #${mi}${also.length ? ` (and the changes from ${also.map(i => `#${i}`).join(', ')})` : ''}`;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text,
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'toggle', worldscrawl_notice_changes: [[mi, pid], ...others.map(d => [d.msg, d.id])], worldscrawl_notice_on: turningOn } };
    chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, off: !turningOn, msgs: [mi, ...also], text };
}
globalThis.worldscrawlToggleChange = toggleChange;
/** The small confirm before turning off a change others may need. Resolves 'all', 'one' or 'cancel'. */
function confirmOff(mi, deps) {
    return new Promise(done => {
        document.querySelector('.worldscrawl_confirm')?.remove();
        const box = document.createElement('div');
        box.className = 'worldscrawl_confirm';
        box.style.cssText = 'position:fixed;z-index:10000;left:50%;top:30%;transform:translateX(-50%);max-width:30em;padding:10px 14px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor, #222);color:var(--SmartThemeBodyColor);box-shadow:0 4px 18px rgba(0,0,0,0.5);';
        const p = t => { const d = document.createElement('div'); d.textContent = t; return d; };
        const desc = d => `#${d.msg}: ${(d.summary ?? []).join('; ') || d.note || d.id}`;
        box.append(p(`Turn off the change from #${mi}?`));
        if (deps.hard.length) { box.append(p('These later changes need it and will stop applying:')); for (const d of deps.hard) box.append(p(`• ${desc(d)}`)); }
        if (deps.overlaps.length) { box.append(p('These touched the same places:')); for (const d of deps.overlaps) box.append(p(`• may depend on #${mi}: ${desc(d)}`)); }
        const row = document.createElement('div'); row.style.marginTop = '6px';
        for (const [label, v] of [['Turn off all', 'all'], ['Just this one', 'one'], ['Cancel', 'cancel']]) row.append(cardButton(label, () => { box.remove(); done(v); }));
        box.append(row);
        document.body.append(box);
    });
}
async function toggleFromCard(mi, pid) {
    let r = await toggleChange(mi, pid);
    if (r.confirm) r = await toggleChange(mi, pid, { choice: await confirmOff(mi, r.confirm) });
    if (!r.ok && r.error) toastr.error(`WorldScrawl: ${r.error}`);
}
/** A live edit from the map window (or anywhere): a hidden system message carrying the stamp. Returns {ok} or {ok:false, errors}. */
export async function liveEdit(ops, note = '', { separate = false } = {}) {
    if (!isOn()) return { ok: false, errors: [{ i: null, error: 'WorldScrawl is off in this chat.' }] };
    const c = ctx(), chat = c.chat ?? [];
    const r = await previewOps(ops);
    if (!r.ok) return r;
    const fl = await loadFormLib();
    const p = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: note || clip(r.preview.summary?.[0] ?? 'map edit', 120), at: chatElapsed(chat),
        ops: r.preview.ops ?? ops, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {}, summary: r.preview.summary, range: null, swipe: 0, source: 'live' };
    // Consecutive editor edits share one carrier message (each patch keeps its id); any other message in between starts a new one.
    const last = chat[chat.length - 1];
    if (!separate && isCarrier(last)) {
        last.extra[PATCH_KEY].push(p);
        last.mes = carrierLine(fl, last.extra[PATCH_KEY]);
        syncSwipeExtra(last);
        c.updateMessageBlock?.(chat.length - 1, last);
        await c.saveChat?.();
    } else {
        const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: carrierLine(fl, [p]), extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'map_edit', [PATCH_KEY]: [p] } };
        chat.push(msg); c.addOneMessage(msg); await c.saveChat?.();
    }
    snapCarriers();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
    return { ok: true, summary: r.preview.summary, msg: chat.length - 1 };
}
globalThis.worldscrawlLiveEdit = liveEdit;

// ---- Map-edit carriers: one compact message holds a run of editor edits.
export const isCarrier = m => m?.extra?.worldscrawl_notice_kind === 'map_edit' && Array.isArray(m.extra?.[PATCH_KEY]) && m.extra[PATCH_KEY].length > 0;
const carrierLine = (fl, ps) => fl?.carrierText ? fl.carrierText(ps) : ps.length === 1 ? `Map edit: ${(ps[0].summary ?? []).join('; ')}` : `Map update (${ps.length} changes)`;
/** Undo one change (from a card or the Changes tab): it leaves its message, which goes once it holds none. Like Turn off,
 *  it asks first when later changes need it ({ok:false, confirm}); choice 'all' also turns those off, 'one' just removes it. */
export async function removeChange(mi, pid, { choice } = {}) {
    const c = ctx(), chat = c.chat ?? [], m = chat[mi], list = m?.extra?.[PATCH_KEY];
    const k = Array.isArray(list) ? list.findIndex(x => x?.id === pid) : -1;
    if (k < 0) return { ok: false, error: 'That change is no longer on its message.' };
    if (choice === 'cancel') return { ok: false, cancelled: true };
    if (list[k].off !== true && choice !== 'one') {
        const deps = await changeDependents(mi, pid);
        if (!choice && (deps.hard.length || deps.overlaps.length)) return { ok: false, confirm: deps };
        if (choice === 'all') for (const d of [...deps.hard, ...deps.overlaps]) { const q = d.msg != null && patchesOn(chat[d.msg]).find(x => x.id === d.id); if (q) { q.off = true; syncSwipeExtra(chat[d.msg]); } }
    }
    list.splice(k, 1);
    if (!list.length && m.extra?.worldscrawl_notice_kind === 'map_edit' && typeof c.deleteMessage === 'function') {
        ownDelete = true;
        try { await c.deleteMessage(mi); } finally { ownDelete = false; }
    } else {
        if (!list.length) delete m.extra[PATCH_KEY];
        else if (m.extra?.worldscrawl_notice_kind === 'map_edit') { m.mes = carrierLine(await loadFormLib(), list); c.updateMessageBlock?.(mi, m); }
        syncSwipeExtra(m);
        await c.saveChat?.();
    }
    snapCarriers();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
    renderPatchCards();
    broadcastMapState();
    return { ok: true };
}
async function removeFromCard(mi, pid) {
    let r = await removeChange(mi, pid);
    if (r.confirm) r = await removeChange(mi, pid, { choice: await confirmOff(mi, r.confirm) });
    if (!r.ok && r.error) toastr.error(`WorldScrawl: ${r.error}`);
}
// Bulk deletes (/del N, /cut, delete mode) can sweep carriers up with them: ST has no event before a delete, so the
// carriers are remembered and compared after MESSAGE_DELETED; a toast offers to put the lost ones back at the end.
let carrierSnap = [], ownDelete = false;
export function snapCarriers() { carrierSnap = (ctx().chat ?? []).filter(isCarrier); }
export let lastLostCarriers = [];
let lastLostAt = 0, lastLostToast = null;
async function onMessagesDeleted() {
    const now = new Set(ctx().chat ?? []), lost = carrierSnap.filter(m => !now.has(m));
    snapCarriers();
    if (!lost.length || ownDelete) return;
    // A range delete (/cut a-b, /del N) can fire one event per message: gather everything lost in one burst into one toast.
    const now2 = Date.now();
    if (now2 - lastLostAt < 3000) { lost.unshift(...lastLostCarriers); try { lastLostToast?.remove?.(); } catch {} }
    lastLostAt = now2;
    lastLostCarriers = lost;
    const n = lost.reduce((a, m) => a + (m.extra?.[PATCH_KEY]?.length ?? 0), 0);
    try { lastLostToast = toastr.warning(`${n} map edit${n === 1 ? ' was' : 's were'} deleted along with those messages. Click to undo.`, 'WorldScrawl: Undo?', { timeOut: 20000, extendedTimeOut: 10000, closeButton: true, onclick: () => restoreCarriers(lost) }); } catch {}
}
/** Put deleted carriers back (same stamps, same patch ids) at the end of the chat. */
export async function restoreCarriers(lost = lastLostCarriers) {
    const c = ctx(), chat = c.chat ?? [];
    for (const m of lost) { const copy = structuredClone(m); copy.send_date = Date.now(); chat.push(copy); c.addOneMessage?.(copy); }
    await c.saveChat?.();
    lastLostCarriers = [];
    snapCarriers();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
    renderPatchCards();
    return lost.length;
}
globalThis.worldscrawlRestoreCarriers = restoreCarriers;
globalThis.worldscrawlResolve = address => api('/resolve', { method: 'POST', body: JSON.stringify({ address, ...mapCtx() }) }).then(r => r.body); // e2e / console
globalThis.worldscrawlLostCarriers = () => lastLostCarriers.length;
async function loadPatchLib() { try { patchLib ??= await import(`${baseUrl()}/ui/patches.mjs`); } catch (e) { console.warn('[WorldScrawl] patches lib unavailable:', e.message); } return patchLib; }

/** Where the story range for a flag on message `end` starts: after the previous flag, or at the last move into or out of `loc`; at most ~10 messages back. */
export function suggestStart(chat, end, loc) {
    const floor = Math.max(0, end - RANGE_CAP + 1);
    for (let i = end - 1; i >= floor; i--) {
        const m = chat[i];
        if (m?.extra?.[FLAG_KEY] || patchesOn(m).length) return i + 1;
        const mv = m?.extra?.[MOVE_KEY];
        if (mv && (mv.to === loc || mv.from === loc)) return i;
    }
    return floor;
}
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
function storyText(chat, start, end, budget = 9000) {
    const lines = [];
    for (let i = start; i <= end; i++) {
        const m = chat[i];
        if (!m || (m.is_system && !m.extra?.worldscrawl_notice)) continue;
        lines.push(`#${i} ${m.name ?? (m.is_user ? 'Player' : 'Narrator')}: ${clip(m.mes, 1500)}`);
    }
    let out = lines.join('\n');
    while (out.length > budget && lines.length > 1) { lines.shift(); out = lines.join('\n'); }
    return out.slice(-budget);
}
/** First JSON object in a model answer (tolerates code fences and chatter). */
export function parseJsonAnswer(text) {
    const t = String(text ?? '').replace(/```(?:json)?/gi, '');
    for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
        let depth = 0, inStr = false, esc = false;
        for (let j = i; j < t.length; j++) {
            const ch = t[j];
            if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
            if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { try { return JSON.parse(t.slice(i, j + 1)); } catch { break; } }
        }
    }
    return null;
}
export const scopeSys = () => P('change.scope_system', { reply: baseReply('json') });
export const patchSys = pl => P('change.system', { reply: baseReply('json'), edit_types: pl.opDocs(), style: P('change.style') });

async function flagContext(f, rooms = []) {
    const r = await api('/patch/context', { method: 'POST', body: JSON.stringify({ location: f.loc, rooms, ...mapCtx() }) });
    if (!r.ok) throw new Error(r.body?.detail?.error ?? r.body?.detail ?? `map server answered ${r.status}`);
    return r.body;
}
const outlineText = c => c.outline.map(o => `${o.address} = ${o.name} [${o.area_name}]; exits: ${o.exits.map(x => `${x.direction}->${x.to}${x.door ? ` (${x.door})` : ''}`).join(', ') || 'none'}`).join('\n');

export const scopePrompt = (c1, { start, id, story, what }) => P('change.scope', { area_name: c1.area_name, area: c1.area, region_name: c1.region_name, outline: outlineText(c1), start, end: id, story, what });
/** The two small model calls (which rooms; then the patch), checked by the server. Leaves the result on the flag. */
/** Debug > Show map edit messages: log each map-edit model call (prompt and raw answer) to the console. */
export function logEditCall(label, prompt, answer) {
    if (!settings().showEditMessages) return;
    console.info(`[WorldScrawl] map edit call: ${label}`, { prompt, answer });
}
async function askModel(c, label, args) {
    const raw = await gen(`map edit: ${label}`, args);
    logEditCall(label, args.prompt, raw);
    return raw;
}
/** How a flag's result is shown: every status ends in a visible line (never an empty card). */
export function flagCardView(f, id) {
    const range = `messages #${f.start}–#${id}`;
    switch (f.status) {
        case 'user': return { text: `🗺 ${USER_FLAG_NOTE}`, buttons: ['Dismiss'] };
        case 'working': return { text: `🗺 Checking what changed on the map (${range})…`, buttons: [] };
        case 'nothing': return { text: `🗺 No map change found in ${range}.${f.error ? ` (${f.error})` : ''}`, buttons: ['Retry', 'Dismiss'] };
        case 'cant': return { text: `🗺 Can't show this on the map: ${f.error || 'no reason given'}`, buttons: ['Retry', 'Dismiss'] };
        case 'review': if (f.proposal) return { text: '🗺 Proposed map change:', buttons: ['review'] }; break;
        case 'error': return { text: `🗺 Map change failed: ${f.error || 'something went wrong.'}`, buttons: ['Retry', 'Dismiss'] };
    }
    if (f.status === 'kept' || f.status === 'discarded') return null;
    return { text: `🗺 Map change failed: unexpected state "${f.status}".`, buttons: ['Retry', 'Dismiss'] };
}
export const USER_FLAG_NOTE = "That's your own message: the narrator's reply will be checked with it when it arrives.";
/** The narrator reply right after message id (skipping engine notices), or -1 if a player message or the end comes first. */
export function replyAfter(chat, id) {
    for (let i = Number(id) + 1; i < (chat?.length ?? 0); i++) { const m = chat[i]; if (!m || m.is_system) continue; return m.is_user ? -1 : i; }
    return -1;
}
/** Scene overrides: a future story engine can flip settings for the current scene (stored on the chat, so they follow it).
 * setSceneOverride('proactiveDiscovery', true|false), or null to fall back to the setting. */
export const SCENE_KEY = 'worldscrawl_scene';
export function sceneOverrides() { try { return ctx().chatMetadata?.[SCENE_KEY] ?? {}; } catch { return {}; } }
export function setSceneOverride(key, value) {
    const c = ctx(); if (!c.chatMetadata) return false;
    const o = { ...(c.chatMetadata[SCENE_KEY] ?? {}) };
    if (value == null) delete o[key]; else o[key] = value;
    c.chatMetadata[SCENE_KEY] = o; c.saveMetadata?.(); discoveryChanged(); return true;
}
globalThis.worldscrawlScene = { get: sceneOverrides, set: setSceneOverride };
/** Proactive room discovery for this scene: the scene override wins, then the setting (off by default). */
export function proactiveDiscovery() { const o = sceneOverrides().proactiveDiscovery; return typeof o === 'boolean' ? o : !!settings().proactiveDiscovery; }
function discoveryChanged() { try { if (hasPrompts() && isOn()) { applyTools(); applyNudge(); } } catch (e) { console.warn('[WorldScrawl]', e?.message); } }
let pendingUserFlag = null; // a flagged player message waiting for the narrator's reply
async function analyzeFlag(id) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], f = msg?.extra?.[FLAG_KEY];
    if (!f) return;
    if (f.kind === 'discover') return analyzeDiscovery(id);
    if (f.start == null || f.start === '' || !Number.isFinite(Number(f.start))) f.start = suggestStart(chat, id, f.loc);
    f.status = 'working'; f.error = ''; delete f.proposal;
    renderPatchCards();
    try {
        await ensurePrompts();
        if (!f.loc) throw new Error('could not tell where the party is for this message');
        const story = storyText(chat, f.start, id);
        const hereNow = await currentLocation().catch(() => null);
        const after = hereNow ? await aftermathNote(ctx().chat ?? [], hereNow).catch(() => '') : '';
        const what = [f.note && `The player or narrator noted: "${clip(f.note, 200)}".`, f.hint && `Place mentioned: "${clip(f.hint, 80)}".`, after].filter(Boolean).join(' ');
        const c1 = await flagContext(f);
        const scopeQ = scopePrompt(c1, { start: f.start, id, story, what });
        const a1 = parseJsonAnswer(await askModel(c, 'which rooms', { prompt: scopeQ, systemPrompt: scopeSys(), responseLength: 200 }));
        if (!a1 || typeof a1 !== 'object') throw new Error("the model's answer about which rooms changed was not JSON");
        const known = [...new Set(c1.outline.map(o => o.address))];
        const toKnown = a => { a = String(a).trim().toLowerCase(); if (known.includes(a)) return a; const t = a.slice(a.indexOf(':') + 1), hit = known.filter(k => k.endsWith(t.includes('/') ? `:${t}` : `/${t}`)); return hit.length === 1 ? hit[0] : null; };
        const areas = [...new Set((a1?.areas ?? []).map(x => String(x).trim().toLowerCase().replace(/\/.*$/, '')))].filter(a => /^[a-z0-9_]+(:[a-z0-9_]+)?$/.test(a)).slice(0, 3);
        // A place changed as a whole (a subregion named in areas): every room in it goes to the patch call too.
        const whole = known.filter(k => areas.some(ar => ar.includes(':') && k.startsWith(`${ar}/`)));
        const rooms = [...new Set([...(a1?.rooms ?? []).map(toKnown).filter(Boolean), ...whole])].slice(0, 20);
        if (!rooms.length && !areas.length) { f.status = 'nothing'; f.error = 'no known room was named'; return; }
        const c2 = await flagContext(f, [...rooms, ...areas]);
        const pl = await loadPatchLib();
        const patchQ = (err = '') => pl.patchPrompt(c2, { story: clip(story, 6000), what, err, range: `#${f.start}-#${id}` });
        let ops = null, err = '', preview = null, merged = [];
        const nearHere = f.loc ? await nearbyRooms({ address: f.loc }).catch(() => []) : [];
        for (let tries = 0; tries < 2; tries++) {
            if (!pl) throw new Error('the map tools (patches.mjs) could not be loaded from the server');
            const ans = pl.readChangeAnswer(parseJsonAnswer(await askModel(c, 'the change', { prompt: patchQ(err), systemPrompt: patchSys(pl), responseLength: 1200 })));
            if (ans?.cant) { f.status = 'cant'; f.error = ans.cant; return; }
            if (ans?.nothing) { f.status = 'nothing'; return; }
            ops = ans?.ops ?? null;
            if (!ops) { err = 'the answer was not {"ops": [...]} JSON'; continue; }
            const md = mergeDuplicates(ops, nearHere); // a "new" room that is a place a few steps away: connect to that place instead
            if (md.merged.length) {
                const rm = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: md.ops }, ...mapCtx() }) });
                if (rm.ok) { preview = rm.body; ops = rm.body.ops ?? md.ops; merged = md.merged; break; }
            }
            const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops }, ...mapCtx() }) });
            if (r.ok) { preview = r.body; ops = r.body.ops ?? ops; break; }
            err = r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status);
        }
        if (!preview) {
            f.error = `The suggested change didn't fit the map: ${err}`;
            if (Array.isArray(ops) && ops.length) { f.status = 'review'; f.proposal = { ops, invalid: true, summary: [`⚠ ${f.error}`], relocate: {}, inherit: {}, names: {}, before: {}, after: {} }; }
            else f.status = 'error';
            return;
        }
        const mergedLines = merged.map(m => `Connected to ${m.to_name} (already on the map, ${m.steps} step${m.steps === 1 ? '' : 's'} away) instead of adding a new "${m.name}".`);
        f.proposal = { ops, summary: [...preview.summary, ...mergedLines], relocate: preview.relocate, inherit: preview.inherit ?? {}, names: preview.names ?? {}, before: preview.before, after: preview.after };
        f.status = 'review';
        if (settings().autoKeep) await keepFlag(id, { quiet: true });
    } catch (e) {
        console.error('[WorldScrawl] map flag', e);
        f.status = 'error'; f.error = e?.message || String(e);
    } finally {
        try { await c.saveChat?.(); } catch (e) { console.error('[WorldScrawl] save', e); }
        renderPatchCards();
    }
}

// ---- Discovery rooms: a door that the room description only mentions (set dressing) is opened in the story, and the
// room behind it is added as if it had always been there: one story-made create_place (a new room with an engine-made
// id and one door pair; old chats' "discover" ops read the same way). No notes, no rewrite of the room it opens from. Stamped at once unless "review discoveries" is on.
export const discoverSys = () => P('discover.system', { reply: baseReply('json'), style: P('discover.style') });
export const discoverPrompt = (k, { exits, near, story, start, id, note, err, existing = [] }) => P('discover.question', { existing: existing.length ? P('discover.existing', { places: optionLines(existing) }) : '', region_name: k.region_name, region_notes: k.region_notes, area_name: k.area_name, area_notes: k.area_notes,
    name: k.name, address: k.location, description: k.description, exits, near, start, end: id, story, door: note ? P('discover.door', { note: clip(note, 200) }) + '\n' : '', retry: err ? P('discover.retry', { error: err }) + '\n' : '' });
/** A discovery answer naming an existing place: one door pair (add_exit) to it. null when the answer is a new room. */
export function existingDiscovery(a, existing, from) {
    if (a?.existing == null || a.existing === '') return null;
    const key = matchKey(String(a.existing), existing.map(o => o.key));
    if (key == null) return { error: `"existing" must be one of the place keys: ${existing.map(o => o.key).join(', ') || '(none): describe a new room'}` };
    const t = x => (typeof a[x] === 'string' && a[x].trim() ? a[x].trim() : undefined);
    if (!t('direction')) return { error: '"direction" is needed' };
    return { op: { op: 'add_exit', loc: from, to: existing.find(o => o.key === key).room.address, direction: t('direction'), return_direction: t('return_direction') ?? 'out', door: true, description: t('exit_description'), return_description: t('return_description') } };
}
async function analyzeDiscovery(id) {
    await ensurePrompts();
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], f = msg?.extra?.[FLAG_KEY];
    if (f.start == null || f.start === '' || !Number.isFinite(Number(f.start))) f.start = suggestStart(chat, id, f.loc);
    f.status = 'working'; f.error = ''; delete f.proposal;
    renderPatchCards();
    try {
        const r0 = await api('/discover/context', { method: 'POST', body: JSON.stringify({ location: f.loc, ...mapCtx() }) });
        if (!r0.ok) throw new Error(r0.body?.detail?.error ?? r0.body?.detail ?? `map server answered ${r0.status}`);
        const k = r0.body;
        if (!k.expandable) { f.status = 'error'; f.error = `${k.name} can't have new rooms (it is marked "expandable": false).`; return; }
        const exits = k.exits.map(x => `${x.direction} -> ${x.to}${x.description ? `: ${x.description}` : ''}`).join('\n') || 'none';
        const near = k.neighbors.map(n => `${n.name} (${n.address}): ${clip(n.description, 300)}`).join('\n') || 'none';
        const story = clip(storyText(chat, f.start, id), 4000);
        // Places nearby that are not connected here yet: the door may lead to one of them instead of a new room.
        const linked = new Set([k.location, ...k.neighbors.map(n => n.address), ...k.exits.map(x => x.to)]);
        const nearAll = await nearbyRooms({ address: k.location });
        const existing = roomOptions(nearAll.filter(r => !linked.has(r.address)));
        const q = err => discoverPrompt(k, { exits, near, story, start: f.start, id, note: f.note, err, existing });
        let preview = null, ops = null, err = '';
        for (let tries = 0; tries < 2 && !preview; tries++) {
            const a = parseJsonAnswer(await askModel(c, 'discovery', { prompt: q(err), systemPrompt: discoverSys(), responseLength: 500 }));
            if (!a || typeof a !== 'object') { err = 'the answer was not JSON'; continue; }
            let ex = existingDiscovery(a, existing, k.location);
            if (ex?.error) { err = ex.error; continue; }
            const dup = !ex && typeof a.name === 'string' ? duplicatePlace(a.name, [...nearAll, ...k.neighbors.map(n => ({ address: n.address, name: n.name, steps: 1 }))], { not: [k.location] }) : null;
            if (dup && linked.has(dup.address)) { f.status = 'nothing'; f.error = `${dup.name} is already connected here, so no new room was added`; return; }
            if (dup) { const o = existing.find(e => e.room.address === dup.address); if (o) { ex = existingDiscovery({ ...a, existing: o.key }, existing, k.location); if (ex?.error) ex = null; else console.log(`[WorldScrawl] discovery: "${a.name}" is ${dup.name}, already on the map: connecting it`); } }
            // The same create_place the editor and the change call use (engine-made id, one door pair back to this room).
            ops = ex ? [ex.op] : [(await loadPatchLib()).discoverToCreate({ loc: k.location, ...Object.fromEntries(['name', 'description', 'direction', 'return_direction', 'exit_description', 'return_description'].filter(x => typeof a[x] === 'string' && a[x].trim()).map(x => [x, a[x].trim()])) })];
            const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops }, ...mapCtx() }) });
            if (r.ok) { preview = r.body; ops = r.body.ops ?? ops; } else err = r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status);
        }
        if (!preview) { f.status = 'error'; f.error = `The new room didn't fit the map: ${err}`; return; }
        f.note = f.note || clip(preview.summary[0], 120);
        f.proposal = { ops, summary: preview.summary, relocate: preview.relocate ?? {}, inherit: preview.inherit ?? {}, names: preview.names ?? {}, before: preview.before, after: preview.after };
        f.status = 'review';
        await keepFlag(id, { quiet: true }); // a discovery is added at once; its 'Map changed here' bar offers Edit / Turn off / Undo
    } catch (e) {
        f.status = 'error'; f.error = e.message;
    } finally {
        await c.saveChat?.();
        renderPatchCards();
        broadcastMapState();
    }
}

/**
 * Flag message `id` as the place where a map change settled, and start the review. The one door for every trigger
 * (button, tool, tag, /ws-change, and future engine actions): opts {note, hint, start, source}.
 */
export async function flagMessage(id, { note = '', hint = '', start = null, source = 'button', kind = '' } = {}) {
    if (!isOn()) return 'WorldScrawl is off in this chat.';
    const c = ctx(), chat = c.chat ?? [];
    id = Number(id);
    const msg = chat[id];
    if (!msg || (msg.is_system && !msg.extra?.worldscrawl_notice)) return 'Pick a story message to flag.';
    msg.extra = msg.extra ?? {};
    if (msg.is_user && source === 'button') { // the change call reads the story up to the narrator's reply: flag that reply, from this message on
        const r = replyAfter(chat, id);
        if (r >= 0) return flagMessage(r, { note, hint, start: id, source, kind });
        msg.extra[FLAG_KEY] = { swipe: swipeOf(msg), loc: locationAt(id) ?? null, source, start: id, status: 'user' };
        pendingUserFlag = { chat: chatKey(), start: id, note, hint };
        renderPatchCards();
        return USER_FLAG_NOTE;
    }
    let loc = null, err = '';
    try { await loadPatchLib(); loc = locationAt(id) ?? (await currentLocation())?.address ?? null; } catch (e) { console.error('[WorldScrawl] map flag', e); err = e?.message || String(e); }
    msg.extra[FLAG_KEY] = { swipe: swipeOf(msg), loc, note: clip(note, 200), hint: clip(hint, 80), source, start: start ?? suggestStart(chat, id, loc), status: err ? 'error' : 'working', ...(err ? { error: err } : {}), ...(kind === 'discover' ? { kind } : {}) };
    try { await c.saveChat?.(); } catch (e) { console.error('[WorldScrawl] save', e); }
    if (err) { renderPatchCards(); return `Map change failed: ${err}`; }
    analyzeFlag(id).catch(e => { const f = msg.extra?.[FLAG_KEY]; if (f) { f.status = 'error'; f.error = e?.message || String(e); } console.error('[WorldScrawl] map flag', e); renderPatchCards(); });
    return kind === 'discover' ? 'Adding the room behind that door…' : 'Checking what changed on the map…';
}
globalThis.worldscrawlFlag = flagMessage;

/** Keep: stamp the proposed patch on the message (the only thing that changes the map). */
async function keepFlag(id, { quiet = false } = {}) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], f = msg?.extra?.[FLAG_KEY];
    if (!f?.proposal) return;
    const form = openForms.get(`${id}|flag`);
    if (f.proposal.invalid && !form) { openEditor(`${id}|flag`, f.proposal.ops, { loc: f.loc ?? getStoredLocation() ?? '' }); return; } // fix it in the editor first
    if (form) {
        const ops = form.getOps();
        if (!ops.length) { form.setErrors([{ i: null, error: 'Nothing to keep: add a change, or press Discard.' }]); return; }
        const r = await previewOps(ops, { changes: chatChanges(chat.slice(0, id + 1)), now: chatElapsed(chat.slice(0, id + 1)) });
        if (!r.ok) { form.setErrors(r.errors); return; }
        f.proposal = { ...f.proposal, ops: r.preview.ops ?? ops, summary: r.preview.summary, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {} };
        openForms.delete(`${id}|flag`);
    }
    if (!markDecided(msg, noticeIdOf(f, 'flag'), form ? 'adjust' : 'approve', { swipe: swipeOf(msg), text: clip((f.proposal.summary ?? []).join('; '), 160) })) return; // already decided
    const p = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: f.note || clip(f.proposal.summary[0], 120), at: chatElapsed(chat.slice(0, id + 1)),
        ops: f.proposal.ops, relocate: f.proposal.relocate ?? {}, inherit: f.proposal.inherit ?? {}, names: f.proposal.names ?? {}, summary: f.proposal.summary, range: { start: f.start, end: id }, swipe: swipeOf(msg) };
    msg.extra[PATCH_KEY] = [...(msg.extra[PATCH_KEY] ?? []), p];
    syncSwipeExtra(msg);
    f.status = 'kept'; f.patch = p.id;
    delete f.proposal.before; delete f.proposal.after;
    await c.saveChat?.();
    exitsCache.clear();
    if (!quiet) toastr.success('WorldScrawl: map changed. Delete this message (or press Undo) to undo it.');
    await applyFacts();
    renderAllExits();
}
/** SillyTavern keeps each swipe's extra in swipe_info: mirror the patches there so swiping away and back keeps them. */
function syncSwipeExtra(msg) {
    const si = msg?.swipe_info?.[swipeOf(msg)];
    if (!si) return;
    si.extra = si.extra ?? {};
    if (msg.extra[PATCH_KEY]) si.extra[PATCH_KEY] = msg.extra[PATCH_KEY]; else delete si.extra[PATCH_KEY];
    if (msg.extra[NPC_KEY]) si.extra[NPC_KEY] = msg.extra[NPC_KEY]; else delete si.extra[NPC_KEY];
    if (msg.extra[REMEMBER_KEY]) si.extra[REMEMBER_KEY] = msg.extra[REMEMBER_KEY]; else delete si.extra[REMEMBER_KEY];
    if (msg.extra[DECIDED_KEY]) si.extra[DECIDED_KEY] = msg.extra[DECIDED_KEY]; else delete si.extra[DECIDED_KEY];
}
async function undoFlag(id) {
    const c = ctx(), msg = c.chat?.[id], f = msg?.extra?.[FLAG_KEY];
    if (!msg) return;
    msg.extra[PATCH_KEY] = (msg.extra[PATCH_KEY] ?? []).filter(p => p.id !== f?.patch);
    if (!msg.extra[PATCH_KEY].length) delete msg.extra[PATCH_KEY];
    delete msg.extra[FLAG_KEY];
    syncSwipeExtra(msg);
    await c.saveChat?.();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
}
async function discardFlag(id) {
    const c = ctx(), msg = c.chat?.[id];
    const f0 = msg?.extra?.[FLAG_KEY];
    if (f0?.status === 'review' && f0.proposal && !markDecided(msg, noticeIdOf(f0, 'flag'), 'discard', { swipe: swipeOf(msg), text: clip((f0.proposal.summary ?? []).join('; '), 160) || 'map change' })) return;
    if (msg?.extra) delete msg.extra[FLAG_KEY];
    await c.saveChat?.();
    renderPatchCards();
}

/** A reply arrived: a [ws_flag: ...] tag in it (non-tools mode) or a ws_flag tool call flags it. */
export async function onReplyForFlags(id) {
    if (!isOn()) return;
    const c = ctx(), msg = c.chat?.[id];
    if (!msg || msg.is_user || msg.is_system) return;
    let flag = null;
    const emitted = [];
    if (pendingFlag) { flag = pendingFlag; pendingFlag = null; emitted.push(`ws_flag ${flag.kind ?? flag.hint ?? ''} (tool)`.trim()); }
    if (pendingUserFlag) {
        const u = pendingUserFlag; pendingUserFlag = null;
        const um = c.chat?.[u.start];
        if (u.chat === chatKey() && um?.extra?.[FLAG_KEY]?.status === 'user' && replyAfter(c.chat, u.start) === id) { delete um.extra[FLAG_KEY]; flag ??= { note: u.note, hint: u.hint, start: u.start, source: 'button' }; renderPatchCards(); }
    }
    const lf = takeLoreFlags(msg.mes ?? ''), lorePlaces = [...pendingLoreFlags.splice(0), ...lf.places];
    if (lf.text !== (msg.mes ?? '')) {
        msg.mes = lf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (lorePlaces.length) {
        try {
            const loc = await currentLocation();
            msg.extra = msg.extra ?? {};
            msg.extra[LORE_KEY] = (msg.extra[LORE_KEY] ?? []).filter(r => (r?.swipe ?? 0) !== swipeOf(msg));
            for (const pl of new Set(lorePlaces)) requestLore(msg, loc, pl, 'flag');
            await c.saveChat?.();
        } catch (e) { console.warn('[WorldScrawl] lore flag', e.message); }
    }
    const kf = takeNameFlags(msg.mes ?? ''), learned = [...pendingNameFlags.splice(0), ...kf.names];
    if (kf.text !== (msg.mes ?? '')) {
        msg.mes = kf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (learned.length) {
        const ch = c.chat ?? [];
        const folded = [...(framesOf(ch, id, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
        msg.extra = msg.extra ?? {};
        msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => !(s?.type === 'npc_name' && (s.swipe ?? 0) === swipeOf(msg)));
        for (const nm of new Set(learned)) { const n = npcForName(folded, nm); if (n) addNpcStamp(msg, { type: 'npc_name', id: n.id, who: PLAYER, source: 'flag' }); }
        await c.saveChat?.();
    }
    const nf = takeNpcFlags(msg.mes ?? ''), npcNames = [...pendingNpcFlags.splice(0), ...nf.names];
    if (nf.text !== (msg.mes ?? '')) {
        msg.mes = nf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (npcNames.length) {
        msg.extra = msg.extra ?? {};
        msg.extra[NPC_FLAG_KEY] = [...(msg.extra[NPC_FLAG_KEY] ?? []).filter(f => (f?.swipe ?? 0) !== swipeOf(msg)), { swipe: swipeOf(msg), names: [...new Set(npcNames)] }];
        await c.saveChat?.();
    }
    const m = FLAG_TAG.exec(msg.mes ?? '');
    if (m) {
        msg.mes = msg.mes.replace(FLAG_TAG, '').trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
        const [hint, ...rest] = m[1].split('|');
        const kind = hint.trim().toLowerCase();
        emitted.push(`ws_flag ${kind}`);
        if ((kind === 'wait' || kind === 'sleep') && !pendingWait) {
            const w = await planWait(rest.join('|'), kind === 'sleep');
            if (!w.error) pendingWait = w; else { console.warn('[WorldScrawl] wait tag:', w.error); noteCall(id, { kind: `ws_flag ${kind}`, status: 'failed', reason: w.error }); }
        } else if (kind === 'discover') flag ??= { kind: 'discover', hint: '', note: rest.join('|').trim(), source: 'tag' };
        else flag ??= { hint: rest.length ? hint.trim() : '', note: (rest.length ? rest.join('|') : hint).trim(), source: 'tag' };
        await c.saveChat?.();
    }
    const wt = WAIT_TAG.exec(msg.mes ?? '');
    if (wt) {
        emitted.push('wait tag');
        msg.mes = msg.mes.replace(WAIT_TAG, '').trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
        if (!pendingWait) { const tg = parseWaitTag(wt[1]); const w = await planWait(tg.args, tg.sleep); if (!w.error) pendingWait = w; else { console.warn('[WorldScrawl] wait tag:', w.error); noteCall(id, { kind: 'wait tag', status: 'failed', reason: w.error }); } }
        await c.saveChat?.();
    }
    if (pendingWait) {
        const w = pendingWait; pendingWait = null;
        const what = narratorWaitAction(c.chat.slice(0, id), w, !!settings().autoKeepWaits);
        if (what !== 'card' && what !== 'keep') { console.log(`[WorldScrawl] narrator wait ignored (${what}): ${w.label}`); noteCall(id, { kind: `narrator wait ${w.label}`, status: 'skipped', reason: what }); }
        else if (what === 'keep') { stampWait(msg, w); await c.saveChat?.(); await applyFacts(); renderAllExits(); broadcastMapState(); }
        else { proposeWait(msg, w); await c.saveChat?.(); renderPatchCards(); }
    }
    if (flag && flag.kind !== 'wait' && digFailedBefore(c.chat, id)) { console.log('[WorldScrawl] map flag ignored: breaking through failed on this turn, so nothing new opened'); noteCall(id, { kind: `ws_flag ${flag.kind ?? ''}`.trim(), status: 'skipped', reason: 'breaking through failed on this turn' }); flag = null; }
    if (flag) await flagMessage(id, flag);
    const taken = takeNpcTags(msg.mes ?? '');
    const fromTool = pendingNpc.splice(0);
    const stamped = [...fromTool, ...taken.stamps];
    for (const s of fromTool) emitted.push(`${s.type} (tool)`);
    for (const s of taken.stamps) emitted.push(`${s.type} tag`);
    noteCall(id, narratorNote(emitted));
    if (taken.text !== (msg.mes ?? '') || stamped.length) {
        if (taken.text !== (msg.mes ?? '')) {
            msg.mes = taken.text;
            if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
            try { c.updateMessageBlock?.(id, msg); } catch {}
        }
        const clock = npcClock(c.chat, id);
        for (const s of stamped) {
            let stamp = s;
            if (s.type === 'npc_staying') stamp = { ...s, elapsed: s.elapsed ?? clock.elapsed };
            else if (s.type === 'npc_stay' && !s.place) {
                const place = positionOf(c.chat, id, PLAYER)?.address || '';
                if (place) stamp = { ...s, place };
            }
            addNpcStamp(msg, stamp);
        }
        syncSwipeExtra(msg);
        await c.saveChat?.();
    }
    maybeSuggest(id);
    if (msg.extra?.[REMEMBER_KEY] || (msg.extra?.[NPC_KEY] ?? []).length) { await c.saveChat?.(); renderPatchCards(); }
}
/** Did the player's turn just before reply `id` fail to break through? Then the reply must not add a room or passage. */
export function digFailedBefore(chat, id) {
    for (let i = id - 1; i >= 0; i--) { const m = chat[i]; if (m?.is_user) return !!m.extra?.worldscrawl_dig_failed; if (m && !m.is_system) return false; }
    return false;
}

// ---- Waiting and sleeping: time passes without moving. The seconds are stamped on a message (WAIT_KEY) exactly like
// a move's travel time, so the clock counts them, deleting the message undoes them and swipes keep them. Triggers:
// /ws-wait, /ws-sleep, the map window's Wait button (asks this tab over the channel), and ws_flag action wait/sleep
// (or a [ws_flag: wait | 2h] tag) from the narrator - stamped straight away, no extra model call, no review card.
/** Sunrise/sunset (seconds of the day) where the party is, from the weather's daylight, for "until dawn" etc. */
function sunFor(loc) {
    const t = worldTimes.get(activeWorld || defaultWorldId);
    if (!weatherLib?.weatherAt || !t?.weather || !loc?.weather?.weather_region) return null;
    return e => { const d = calendarLib.dateAt(e, t.start_date, t.calendar); const w = weatherLib.weatherAt(t.weather, loc.weather.weather_region, weatherLib.absSeconds(d, t.calendar), t.calendar); return { sunrise: w.sunrise, sunset: w.sunset }; };
}
/** A loose wait amount read by a small model call: {seconds} or {until}, or null. Checked by the same parser. */
export async function modelWait(amount, cal = null, lib = calendarLib) {
    try {
        if (!lib) return null;
        await ensurePrompts();
        const a = parseJsonAnswer(await gen('wait amount', { prompt: P('intent.wait_amount', { amount: clip(String(amount), 120) }), systemPrompt: P('intent.wait_amount_system', { reply: baseReply('json') }), responseLength: 40 }));
        const c = cal ? lib.checkCalendar(cal) : undefined;
        if (Number.isFinite(Number(a?.seconds)) && Number(a.seconds) > 0) return { seconds: Math.min(Math.round(Number(a.seconds)), 30 * 86400) };
        if (typeof a?.until === 'string' && a.until.trim()) return lib.parseWait(`until ${a.until.trim()}`, c);
    } catch (e) { console.warn('[WorldScrawl] wait amount', e.message); }
    return null;
}
/** Work out a wait from its arguments: {seconds, sleep, label, until, afterText} or {error}. Nothing is stamped. */
export async function planWait(args, sleep = false) {
    if (!(await loadCalendar())) return { error: 'the game clock is unavailable' };
    const t = worldTimes.get(activeWorld || defaultWorldId), cal = t?.calendar ?? null;
    args = String(args ?? '').trim();
    let p;
    try { p = args ? calendarLib.parseWait(args, cal ? calendarLib.checkCalendar(cal) : undefined) : sleep ? { seconds: calendarLib.SLEEP_DEFAULT } : null; } catch (e) {
        p = await modelWait(args, cal); // a loose amount the parser can't read: one small model call before failing
        if (!p) return { error: e.message };
    }
    if (!p) return { error: 'say how long, e.g. "/ws-wait 2h" or "/ws-wait until morning"' };
    const now = chatElapsed();
    let seconds = p.seconds;
    if (p.until) {
        let sun = null; try { sun = sunFor(await currentLocation()); } catch {}
        try { seconds = calendarLib.untilSeconds(now, p.until, t?.start_date ?? null, cal, sun); } catch (e) { return { error: e.message }; }
    }
    const dur = calendarLib.formatDuration(seconds);
    const label = `${sleep ? 'slept' : 'waited'} ${dur}${p.until ? ` (until ${p.until})` : ''}`;
    let afterText = '';
    try { afterText = calendarLib.describeDate(calendarLib.dateAt(now + seconds, t?.start_date ?? null, cal)); } catch {}
    return { seconds, sleep, label, until: p.until ?? null, afterText };
}
/** Narrator waits under this are ignored: no card, no clock change. */
export const MIN_NARRATOR_WAIT = 15 * 60;
/**
 * What to do with a wait the narrator proposed, given the chat before its reply: 'short' (under 15 minutes: ignored),
 * 'explicit' (the player's own turn already passed time: /ws-wait, [wait], [sleep]; ignored so it is not counted twice),
 * 'keep' (Auto-keep waits) or 'card'. Explicit waits are stamped directly by their own code and never get a card.
 */
export function narratorWaitAction(chatBefore, w, autoKeep = false) {
    if (!(w?.seconds >= MIN_NARRATOR_WAIT)) return 'short';
    for (let i = chatBefore.length - 1; i >= 0; i--) {
        const m = chatBefore[i];
        if (m?.extra?.[WAIT_KEY]?.seconds > 0) return 'explicit';
        if (m?.is_user && !m.extra?.worldscrawl_engine) break;
    }
    return autoKeep ? 'keep' : 'card';
}
/** A narrator wait waits for the player: Keep, Adjust or Discard on a card (unless Auto-keep waits is on). */
const waitAsk = () => (settings().autoKeepWaits ? '' : ' (The player will confirm it.)');
/** The amount as the player would type it: "until morning", "2h 30m". */
export const waitAmount = w => (w.until ? `until ${w.until}` : calendarLib?.formatDuration ? calendarLib.formatDuration(w.seconds) : `${Math.round(w.seconds / 60)}m`);
export function proposeWait(msg, w) {
    msg.extra = msg.extra ?? {};
    msg.extra[WAITCARD_KEY] = { nid: newNoticeId('wait'), swipe: swipeOf(msg), seconds: w.seconds, sleep: !!w.sleep, label: w.label, until: w.until ?? null, amount: waitAmount(w) };
}
/** Keep (amount unchanged) or Adjust (a new amount) a proposed wait: the same stamp as a narrator wait kept at once. */
export async function keepWait(id, amount = null) {
    const c = ctx(), msg = c.chat?.[id], p = msg?.extra?.[WAITCARD_KEY];
    if (!p) return 'no wait to keep';
    const nid = noticeIdOf(p, 'wait');
    if (isDecided(msg, nid)) return 'already decided';
    const r = await once(nid, () => keepWaitNow(c, msg, p, nid, amount));
    return r ?? 'already saving';
}
async function keepWaitNow(c, msg, p, nid, amount) {
    let w = p;
    if (amount != null && String(amount).trim() && String(amount).trim().toLowerCase() !== String(p.amount).toLowerCase()) {
        w = await planWait(String(amount), p.sleep);
        if (w.error) { toastr.warning(`WorldScrawl: ${w.error}`); return w.error; }
    }
    if (!markDecided(msg, nid, w === p ? 'approve' : 'adjust', { swipe: swipeOf(msg), text: `${w.label} passed` })) return 'already decided';
    stampWait(msg, w); delete msg.extra[WAITCARD_KEY];
    renderPatchCards();
    await c.saveChat?.(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
    return '';
}
/** Which temporary changes a re-timed wait now runs past (crossed) or no longer reaches (uncrossed), keyed by change and op. */
export function waitExpiryDelta(changes, start, oldSec, newSec, expiredBetween) {
    const key = g => `${g.id ?? ''}#${g.op ?? g.index ?? ''}#${g.note}`;
    const was = expiredBetween(changes, start, start + oldSec), now = expiredBetween(changes, start, start + newSec);
    const wk = new Set(was.map(key)), nk = new Set(now.map(key));
    return { crossed: now.filter(g => !wk.has(key(g))), uncrossed: was.filter(g => !nk.has(key(g))) };
}
/** Re-time an already-kept wait. The clock moves, so expiries are rechecked: the map is rebuilt from the chat (the server keeps no state). */
export async function editKeptWait(id, amount) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], old = msg?.extra?.[WAIT_KEY];
    if (!old) return { error: 'no kept wait on that message' };
    const w = await planWait(String(amount), old.sleep);
    if (w.error) return { error: w.error };
    const lib = await loadPatchLib();
    const start = chatElapsed(chat.slice(0, id + 1)) - old.seconds;
    const delta = lib?.expiredBetween ? waitExpiryDelta(chatChanges(chat), start, old.seconds, w.seconds, lib.expiredBetween) : { crossed: [], uncrossed: [] };
    stampWait(msg, w);
    await c.saveChat?.(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
    if (delta.crossed.length) toastr.info(`WorldScrawl: now runs out during the wait: ${delta.crossed.map(g => g.note).join('; ')}`);
    if (delta.uncrossed.length) toastr.info(`WorldScrawl: still in place after the shorter wait: ${delta.uncrossed.map(g => g.note).join('; ')}`);
    return delta;
}
export async function discardWait(id) {
    const c = ctx(), msg = c.chat?.[id], p = msg?.extra?.[WAITCARD_KEY];
    if (!p) return;
    if (!markDecided(msg, noticeIdOf(p, 'wait'), 'discard', { swipe: swipeOf(msg), text: `no time passes (${p.label})` })) return;
    delete msg.extra[WAITCARD_KEY];
    renderPatchCards(); await c.saveChat?.();
}
function stampWait(msg, w) {
    msg.extra = msg.extra ?? {};
    msg.extra[WAIT_KEY] = { seconds: w.seconds, sleep: !!w.sleep, label: w.label, ...(w.until ? { until: w.until } : {}) };
}
/** The auto-sent wait message: "*Knarfy waits for 2h.*", "*Knarfy sleeps for 8h, until morning.*" */
export function waitNote(who, w) {
    const dur = calendarLib?.formatDuration ? calendarLib.formatDuration(w.seconds) : `${w.seconds}s`;
    return `*${who} ${w.sleep ? 'sleeps' : 'waits'} for ${dur}${w.until ? `, until ${w.until}` : ''}.*`;
}
/** /ws-wait and /ws-sleep (and the map's Wait button): post a stamped message, then let the narrator describe it. */
export async function waitCommand(args, sleep = false) {
    const c = ctx();
    if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; }
    if (engineBusy) return 'WorldScrawl: busy.';
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    const w = await planWait(args, sleep);
    if (w.error) { toastr.warning(`WorldScrawl: ${w.error}`); return w.error; }
    engineBusy = true;
    try {
        const who = partyText(), dur = calendarLib.formatDuration(w.seconds);
        const note = waitNote(who, w);
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stampWait(msg, w);
        msg.extra.worldscrawl_engine = true;
        await c.saveChat();
        renderAllExits(); broadcastMapState();
        await narrate(c);
        return '';
    } catch (e) { toastr.error(e.message); return e.message; } finally { engineBusy = false; }
}
/** The latest wait the narrator has not described yet: on the latest user message or after it. */
function recentWait(chat) {
    const ui = lastUserIndex(chat);
    for (let i = chat.length - 1; i >= Math.max(0, ui); i--) if (chat[i]?.extra?.[WAIT_KEY]?.seconds > 0) return { i, w: chat[i].extra[WAIT_KEY] };
    return null;
}
/** Narrator lines for a wait: how long, the time before and now, daylight/weather now and before, expired changes. */
async function waitFacts(chat, loc) {
    const r = recentWait(chat);
    if (!r || !calendarLib) return '';
    const t = worldTimes.get(activeWorld || defaultWorldId), after = chatElapsed(chat.slice(0, r.i + 1)), before = after - r.w.seconds;
    const who = partyText(), dur = calendarLib.formatDuration(r.w.seconds);
    const lines = [];
    try {
        const d0 = calendarLib.dateAt(before, t?.start_date ?? null, t?.calendar ?? null), d1 = calendarLib.dateAt(after, t?.start_date ?? null, t?.calendar ?? null);
        lines.push(`What just happened: ${who} ${r.w.sleep ? 'slept' : 'waited'} here for ${dur}, without travelling. It was ${calendarLib.describeDate(d0)}; it is now ${calendarLib.describeDate(d1)}.${d0.part !== d1.part ? ` The light has changed from ${d0.part} to ${d1.part}.` : ''}${r.w.sleep ? ' Narrate waking up.' : ''}`);
    } catch {}
    const w0 = placeWeatherNow(loc, chat.map((m, j) => (j === r.i ? { ...m, extra: { ...m.extra, [WAIT_KEY]: undefined } } : m))), w1 = placeWeatherNow(loc, chat);
    if (w0?.line && w1?.line && w0.line !== w1.line) lines.push(`Before the wait: ${w0.line} Describe how the weather has changed.`);
    const lib = await loadPatchLib();
    const gone = lib?.expiredBetween ? lib.expiredBetween(chatChanges(chat), before, after) : [];
    if (gone.length) lines.push(`While ${who} ${r.w.sleep ? 'slept' : 'waited'}, these temporary changes ran out and are gone now: ${gone.map(g => g.note).join('; ')}.`);
    return lines.join('\n');
}

/** A notice button. decides: answering the notice (Approve / Adjust / Discard...): the first click locks the whole row
 * ("Saving…"), later clicks are ignored, and the notice redraws when the work is done (the write itself is decide-once). */
function cardButton(label, onClick, title = '', decides = false) {
    const b = document.createElement('span');
    b.className = 'menu_button worldscrawl_card_btn'; b.textContent = label; if (title) b.title = title;
    b.style.cssText = 'display:inline-block;padding:2px 8px;margin:0;font-size:0.9em;white-space:nowrap;width:auto;';
    if (decides) b.dataset.decides = '1';
    b.addEventListener('click', e => {
        e.stopPropagation();
        if (!decides) return onClick();
        const row = b.closest('.worldscrawl_notice_row');
        if (row && !lockRow(row)) return; // already saving
        Promise.resolve().then(onClick).catch(err => { console.error('[WorldScrawl] notice', err); toastr.error(`WorldScrawl: ${err?.message || err}`); }).finally(() => { if (row?.isConnected) renderPatchCards(); });
    });
    return b;
}
/** Notice text, then ONE right-aligned button row at the end. */
const rowOf = (...buttons) => noticeRow(document, buttons.flat());
const fieldsOf = (...els) => { const f = document.createElement('div'); f.className = 'worldscrawl_notice_fields'; f.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;'; f.append(...els.filter(Boolean)); return f; };
/** Flag buttons on messages and the Keep / Discard cards (DOM only; never in message text). */
export function renderPatchCards() {
    const ch = ctx().chat ?? [];
    if (isOn()) refreshChangeStatus();
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid')), msg = ch[id];
        el.querySelector('.worldscrawl_patchcard')?.remove();
        if (!msg) continue;
        const bar = el.querySelector('.extraMesButtons') ?? el.querySelector('.mes_buttons');
        if (bar && !bar.querySelector('.worldscrawl_flag_btn') && !msg.is_system && isOn()) {
            const b = document.createElement('div');
            b.className = 'mes_button worldscrawl_flag_btn fa-solid fa-flag';
            b.title = 'WorldScrawl: the map changed here (fire, collapse, smashed door...)';
            b.addEventListener('click', e => { e.stopPropagation(); flagMessage(Number(el.getAttribute('mesid'))).then(t => t && toastr.info(`WorldScrawl: ${t}`), err => { console.error('[WorldScrawl] map flag', err); toastr.error(`WorldScrawl: map change failed: ${err?.message || err}`); }); });
            bar.prepend(b);
        }
        if (!isOn()) { el.querySelector('.worldscrawl_flag_btn')?.remove(); continue; }
        const f = msg.extra?.[FLAG_KEY];
        const kept = patchesOn(msg);
        const wc = msg.extra?.[WAITCARD_KEY], waitCard = wc && (wc.swipe ?? 0) === swipeOf(msg);
        const remember = msg.extra?.[REMEMBER_KEY], rememberCard = remember && remember.status === 'review' && (remember.swipe ?? 0) === swipeOf(msg);
        const npcStamps = (msg.extra?.[NPC_KEY] ?? []).filter(s => s && (s.swipe ?? 0) === swipeOf(msg) && !['npc_appear', 'npc_seek', 'npc_decline'].includes(s.type));
        const resolved = Object.entries(msg.extra?.[DECIDED_KEY] ?? {}).filter(([nid, d]) => (d?.swipe ?? 0) === swipeOf(msg) && (!nid.startsWith('flag_') || d.action === 'discard') && !(rememberCard && remember.nid === nid));
        if ((!f || (f.swipe ?? 0) !== swipeOf(msg)) && !kept.length && !waitCard && !rememberCard && !npcStamps.length && !resolved.length) continue;
        const card = document.createElement('div');
        card.className = 'worldscrawl_patchcard';
        card.style.cssText = 'margin-top:6px;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;font-size:0.9em;';
        const line = t => { const d = document.createElement('div'); d.textContent = t; return d; };
        const startPicker = () => {
            const wrap = document.createElement('span');
            wrap.append('Story from message #');
            const inp = document.createElement('input');
            const suggested = suggestStart(ctx().chat ?? [], id, f.loc);
            if (f.start == null || f.start === '' || !Number.isFinite(Number(f.start))) f.start = suggested;
            inp.type = 'number'; inp.min = '0'; inp.max = String(id); inp.value = String(f.start); inp.placeholder = String(suggested);
            inp.className = 'text_pole worldscrawl_start';
            inp.style.cssText = 'width:5em;display:inline-block;margin:0 2px;padding:1px 4px;color:var(--SmartThemeBodyColor);background-color:var(--SmartThemeShadowColor, rgba(0,0,0,0.3));border:1px solid var(--SmartThemeBorderColor);border-radius:4px;';
            inp.addEventListener('click', e => e.stopPropagation());
            inp.addEventListener('change', () => { const v = inp.value.trim(); f.start = v === '' || !Number.isFinite(Number(v)) ? suggested : Math.max(0, Math.min(id, Math.floor(Number(v)))); inp.value = String(f.start); ctx().saveChat?.(); });
            wrap.append(inp, ` to #${id} `);
            return wrap;
        };
        if (f && (f.swipe ?? 0) === swipeOf(msg)) {
            const view = flagCardView(f, id);
            if (view && view.buttons[0] !== 'review') {
                const t = line(view.text); t.className = `worldscrawl_flag_${f.status}`; card.append(t);
                if (view.buttons.includes('Retry')) card.append(fieldsOf(startPicker()));
                const bs = [view.buttons.includes('Retry') && cardButton('Retry', () => analyzeFlag(id)), view.buttons.includes('Dismiss') && cardButton('Dismiss', () => discardFlag(id))].filter(Boolean);
                if (bs.length) card.append(rowOf(bs));
            } else if (f.status === 'review' && f.proposal) {
                const rc = markPending(document.createElement('div')); rc.classList.add('worldscrawl_flagreview'); card.append(rc);
                { const card = rc; // the review notice: text, diff, fields, then one row
                card.append(line(f.proposal.invalid ? "🗺 The suggested change didn't fit the map. Press Edit to fix it (Approve opens the editor):" : '🗺 Proposed map change:'));
                const ul = document.createElement('ul'); ul.style.margin = '2px 0 4px 1.2em';
                for (const s of f.proposal.summary ?? []) { const li = document.createElement('li'); li.textContent = s; ul.append(li); }
                card.append(ul);
                const here = getStoredLocation();
                if (here && f.proposal.relocate?.[here]) card.append(line(`The party will be moved to ${f.proposal.relocate[here]}.`));
                const diffBox = document.createElement('div'); diffBox.className = 'worldscrawl_diff';
                card.append(diffBox);
                const form = openForms.get(`${id}|flag`);
                drawDiff(diffBox, form?.lastPreview ?? f.proposal);
                if (form) {
                    card.append(form.el); form.diffBox = diffBox;
                    form.onLive = ops => liveDiff(diffBox, ops, { changes: chatChanges(ch.slice(0, id + 1)), now: chatElapsed(ch.slice(0, id + 1)) }, form);
                }
                card.append(fieldsOf(startPicker()), rowOf(cardButton('Check again', () => { openForms.delete(`${id}|flag`); analyzeFlag(id); }, 'Ask again with this story range'),
                    form ? cardButton('Close editor', () => { openForms.delete(`${id}|flag`); renderPatchCards(); }, 'Forget the edits and keep the suggestion as it was')
                        : cardButton('Edit', () => openEditor(`${id}|flag`, f.proposal.ops, { loc: Object.keys(f.proposal.before ?? {})[0] ?? getStoredLocation() ?? '' }), 'Change, add or remove parts of this change before approving it'),
                    cardButton(form ? 'Approve edited' : 'Approve', () => keepFlag(id), 'Put this change on the map', true), cardButton('Discard', () => { openForms.delete(`${id}|flag`); return discardFlag(id); }, 'Leave the map as it is', true)));
                }
            }
        }
        if (waitCard) {
            const d = markPending(document.createElement('div')); d.classList.add('worldscrawl_waitcard');
            d.append(line(`⏳ The narrator passed time: ${wc.label}.`));
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = wc.amount; inp.className = 'text_pole worldscrawl_wait_amount'; inp.title = 'e.g. 45m, 2h, 1h30m, until dawn';
            inp.style.cssText = 'width:9em;display:inline-block;margin:0 4px;padding:1px 4px;';
            inp.addEventListener('click', e => e.stopPropagation());
            const note = line('A shortened or discarded wait may disagree with the story text; swipe the reply to fix that.');
            note.style.opacity = '0.7'; note.style.fontSize = '0.9em';
            d.append(fieldsOf('Amount:', inp), note, rowOf(cardButton('Approve', () => keepWait(id), `Let ${wc.amount} pass`, true), cardButton('Adjust', () => keepWait(id, inp.value), 'Let the amount in the box pass instead', true),
                cardButton('Discard', () => discardWait(id), 'No time passes', true)));
            card.append(d);
        }
        if (rememberCard) {
            const d = markPending(document.createElement('div')); d.classList.add('worldscrawl_remembercard');
            d.append(line(remember.suggested ? `Remember ${remember.name}? They have come up a few times.` : `Remember ${remember.name}?`));
            const nameInp = document.createElement('input');
            nameInp.type = 'text'; nameInp.value = remember.name; nameInp.className = 'text_pole worldscrawl_remember_name';
            nameInp.style.cssText = 'width:10em;display:inline-block;margin:0 4px;padding:1px 4px;';
            nameInp.addEventListener('click', e => e.stopPropagation());
            const lineInp = document.createElement('input');
            lineInp.type = 'text'; lineInp.placeholder = 'one sentence (optional)'; lineInp.className = 'text_pole worldscrawl_remember_line';
            lineInp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
            lineInp.addEventListener('click', e => e.stopPropagation());
            d.append(fieldsOf(nameInp, lineInp), rowOf(cardButton('Approve', () => keepRemember(id), `Remember ${remember.name} (the narrator writes one sentence about them)`, true),
                cardButton('Adjust', () => keepRemember(id, { name: nameInp.value, line: lineInp.value }), 'Approve with the name and the sentence in the boxes', true),
                cardButton('Discard', () => discardRemember(id), 'Not this scene. You can be asked again after the scene changes.', true)));
            if (isDecided(msg, remember.nid)) lockRow(d.querySelector('.worldscrawl_notice_row')); // still saving (redrawn mid-save)
            card.append(d);
        }
        for (const [, dd] of resolved) { const r = line(resolvedText(dd)); r.className = 'worldscrawl_notice worldscrawl_resolved'; card.append(r); }
        const npcNames = new Map((castPack()?.npcs ?? []).map(n => [n.id, n.name]));
        for (const m of ch) for (const s of m?.extra?.[NPC_KEY] ?? []) if (s?.id && s.name) npcNames.set(s.id, s.name);
        let exported = new Set();
        for (const s of npcStamps) {
            const who = npcNames.get(s.id) || s.name || s.id;
            const d = line(s.off ? `Character change turned off: ${stampSummary(s, who)}` : `Character changed here: ${stampSummary(s, who)}`);
            d.className = 'worldscrawl_npcchange';
            if (s.type === 'npc_create' && !s.off && (s.looks || s.body || s.outfit || s.history || s.invented?.length)) {
                const more = document.createElement('div');
                more.className = 'worldscrawl_npccreate_more';
                more.style.cssText = 'font-size:0.9em;opacity:0.85;margin:2px 0 2px 1em;';
                for (const [k, label] of [['looks', 'Looks'], ['body', 'Body'], ['outfit', 'Wearing'], ['history', 'History']]) if (s[k]) { const a = document.createElement('div'); a.textContent = `${label}: ${s[k]}`; more.append(a); }
                if (s.invented?.length) { const v = document.createElement('div'); v.className = 'worldscrawl_invented'; v.textContent = `Made up to fill gaps (not in the story): ${s.invented.join('; ')}. Change any of it in the map's cast panel (In this chat) before you export.`; more.append(v); }
                d._more = more;
            }
            if (s.off) d.style.opacity = '0.6';
            const nrow = rowOf(); const fields = fieldsOf(); d.append(nrow);
            const textKey = s.type === 'npc_memory' ? 'note' : s.type === 'npc_disposition' ? 'reason' : 'text';
            if (!s.off && (s.type === 'npc_fact' || s.type === 'npc_memory' || s.type === 'npc_disposition' || s.type === 'npc_create')) {
                nrow.append(cardButton('Edit', () => {
                    const inp = document.createElement('input');
                    inp.type = 'text'; inp.value = s.type === 'npc_create' ? (s.line ?? '') : (s[textKey] ?? ''); inp.className = 'text_pole';
                    inp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
                    inp.addEventListener('click', e => e.stopPropagation());
                    const save = cardButton('Save', () => {
                        if (s.type === 'npc_create') { s.line = inp.value.trim() || s.line; if (s.name) npcNames.set(s.id, s.name); }
                        else s[textKey] = inp.value.trim();
                        syncSwipeExtra(msg); ctx().saveChat?.(); renderPatchCards();
                    });
                    fields.append(inp, save); d.insertBefore(fields, nrow);
                }, 'Edit this note'));
            }
            nrow.append(cardButton(s.off ? 'Turn on' : 'Turn off', () => { s.off = !s.off; syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); }, s.off ? 'Use this note again' : 'Keep the note here but stop using it'));
            nrow.append(cardButton('Undo', () => {
                msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s);
                if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY];
                syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards();
            }, 'Remove this note (deleting the message does the same)'));
            if (!s.off && s.id && !exported.has(s.id)) {
                exported.add(s.id);
                const live = npcAt(ch, ch.length - 1, castPack()?.npcs ?? [], s.id);
                const castNpc = (castPack()?.npcs ?? []).find(n => n.id === s.id && n.ok !== false && n.from !== 'play');
                if (live?.from === 'cast' && castNpc) {
                    nrow.append(cardButton(`Update ${who}`, () => {
                        d.querySelector('.worldscrawl_castdiff')?.remove();
                        const now = npcAt(ctx().chat ?? [], (ctx().chat ?? []).length - 1, castPack()?.npcs ?? [], s.id);
                        const diff = recordDiff(castNpc, now);
                        const box = document.createElement('div');
                        box.className = 'worldscrawl_castdiff';
                        box.style.cssText = 'margin-top:4px;';
                        const pre = document.createElement('pre');
                        pre.style.cssText = 'white-space:pre-wrap;margin:4px 0;font-size:0.9em;';
                        pre.textContent = diff.changed ? diff.text : 'Nothing has changed since the cast file.';
                        box.append(pre);
                        box.append(rowOf(diff.changed && cardButton('Confirm', () => exportNpc(s.id, { update: true }), 'Write this record over the cast file'), cardButton('Cancel', () => { box.remove(); }, 'Leave the cast file as it is')));
                        d.append(box);
                    }, 'Show what would change in the cast file, then write it in place'));
                } else nrow.append(cardButton('Export', () => exportNpc(s.id), 'Write this person into the world\'s cast folder. An existing file is kept.'));
            }
            card.append(d);
            if (d._more) card.append(d._more);
        }
        // A carrier (a run of map-window edits) is one small line, collapsed; it opens to list each change with its buttons.
        const carrier = isCarrier(msg), showAll = !!settings().showEditMessages; // Debug > Show map edit messages: full message, list open
        el.classList.toggle('worldscrawl_carrier_mes', carrier && !showAll);
        let box = card;
        if (carrier) {
            const det = document.createElement('details'); det.className = 'worldscrawl_carrier';
            if (showAll || kept.some(p => openForms.has(`${id}|${p.id}`)) || openCarriers.has(msg)) det.open = true;
            det.addEventListener('toggle', () => { if (det.open) openCarriers.add(msg); else openCarriers.delete(msg); });
            const sum = document.createElement('summary'); sum.textContent = `🗺 ${msg.mes}`; det.append(sum);
            card.append(det); box = det;
        }
        for (const p of kept) {
            const what = (p.summary ?? []).join('; ') || p.note;
            if (p.off === true) {
                const d = line(`🗺 Map change turned off: ${what}`);
                d.className = 'worldscrawl_change_off'; d.style.opacity = '0.6';
                d.append(rowOf(cardButton('Turn on', () => toggleFromCard(id, p.id), 'Put this change back on the map')));
                box.append(d);
                continue;
            }
            const d = line(`🗺 Map changed here: ${what}`);
            const key = `${id}|${p.id}`, form = openForms.get(key);
            d.append(rowOf(form ? cardButton('Close editor', () => { openForms.delete(key); renderPatchCards(); }) : cardButton('Edit', () => editChangeInTab(id, p, () => openEditor(key, p.ops)), 'Change this kept change in the map editor (a new tab); it stays on this message'),
                ...(failedFor(id, p.id)?.inactive ? [] : [cardButton('Turn off', () => toggleFromCard(id, p.id), 'Take this change off the map for now (it stays here; turn it on again any time)')]),
                cardButton('Undo', () => { if (isCarrier(msg)) removeFromCard(id, p.id); else { if (f) f.patch = p.id; else { msg.extra[FLAG_KEY] = { patch: p.id }; } undoFlag(id); } }, 'Remove this change (deleting the message does the same)')));
            box.append(d);
            const bad = failedFor(id, p.id);
            if (bad?.inactive) { const w = line(bad.inactive); w.className = 'worldscrawl_inactive'; w.style.opacity = '.6'; box.append(w); }
            else if (bad) { const w = line(`⚠ can't apply: ${bad.error}`); w.className = 'worldscrawl_cant_apply'; w.style.color = '#e55'; box.append(w); }
            if (form) {
                const diffBox = document.createElement('div'); diffBox.className = 'worldscrawl_diff';
                form.onLive = ops => liveDiff(diffBox, ops, { changes: chatChanges(ch.slice(0, id)), now: chatElapsed(ch.slice(0, id + 1)) }, form);
                box.append(form.el, diffBox, cardButton('Save change', () => saveKeptEdit(id, p.id, form)));
                form.onLive(form.getOps());
            }
        }
        if (!card.childNodes.length) continue;
        (el.querySelector('.mes_block') ?? el).appendChild(card);
    }
}

const openCarriers = new WeakSet();
(function carrierCss() {
    if (typeof document === 'undefined' || document.getElementById('worldscrawl_carrier_css')) return;
    const st = document.createElement('style'); st.id = 'worldscrawl_carrier_css';
    st.textContent = `${NOTICE_CSS}
#chat .mes.worldscrawl_carrier_mes{padding:2px 10px;min-height:0;overflow:hidden;font-size:0.82em;}
#chat .mes.worldscrawl_carrier_mes .mes_text,#chat .mes.worldscrawl_carrier_mes .avatar,#chat .mes.worldscrawl_carrier_mes .mesIDDisplay,#chat .mes.worldscrawl_carrier_mes .mes_timer,#chat .mes.worldscrawl_carrier_mes .tokenCounterDisplay{display:none;}
#chat .mes.worldscrawl_carrier_mes .worldscrawl_patchcard{margin-top:0!important;padding:2px 6px!important;font-size:1em!important;}
.worldscrawl_carrier>summary{cursor:pointer;opacity:0.85;}
.worldscrawl_carrier>div{margin:2px 0 2px 1em;}`;
    (document.head ?? document.documentElement).append(st);
})();
function addSettingsPanel() {
    const html = `
<div class="worldscrawl_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>WorldScrawl</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input id="worldscrawl_enabled" type="checkbox"> <b>Enabled in this chat</b></label>
      <label class="checkbox_label"><input id="worldscrawl_enable_new" type="checkbox"> Enable in new chats</label>
      <div class="flex-container"><div id="worldscrawl_open_map" class="menu_button" title="Opens the WorldScrawl window in a new tab; it follows this chat live">Open map window</div></div>
      <label for="worldscrawl_url">Map server URL (leave empty to use the WorldScrawl plugin built into SillyTavern)</label>
      <input id="worldscrawl_url" class="text_pole" type="text" placeholder="(SillyTavern plugin)">
      <div class="flex-container"><div id="worldscrawl_test" class="menu_button">Test connection</div></div>
      <small id="worldscrawl_status"></small>
      <label for="worldscrawl_who">Who moves (used in move messages and notes to the model; macros like {{user}} work)</label>
      <input id="worldscrawl_who" class="text_pole" type="text" placeholder="{{user}}">
      <label for="worldscrawl_world">World for new chats</label>
      <div class="flex-container"><select id="worldscrawl_world" class="text_pole flex1"><option value="">(server default)</option></select>
        <div id="worldscrawl_open_world" class="menu_button" title="Open this world's folder">Open</div></div>
      <div class="flex-container"><div id="worldscrawl_open_folder" class="menu_button">Open worlds folder</div></div>
      <label for="worldscrawl_save_name">Save this chat's world as</label>
      <input id="worldscrawl_save_name" class="text_pole" type="text" placeholder="">
      <label class="checkbox_label"><input id="worldscrawl_save_knowledge" type="checkbox"> Include this chat's discoveries</label>
      <small>New chats on this world start where you are and already know the places and doors you've found. If it's off, new chats start fresh.</small>
      <div class="flex-container"><div id="worldscrawl_save" class="menu_button">Save world</div></div>
      <label class="checkbox_label"><input id="worldscrawl_save_switch" type="checkbox" checked> Switch this chat to the saved world</label>
      <label class="checkbox_label"><input id="worldscrawl_show_exits" type="checkbox"> Show exits footer</label>
      <div>Map changes</div>
      <label class="checkbox_label"><input id="worldscrawl_auto_keep" type="checkbox"> Approve map changes without asking (skip the Approve / Discard card)</label>
      <label class="checkbox_label" title="Off: a room is only discovered when a door that isn't on the map is actually opened or entered. On: rooms the narration mentions (a hallway lined with guest rooms) may be added too."><input id="worldscrawl_proactive_discovery" type="checkbox"> Proactive room discovery (add rooms the narration mentions)</label>
      <label class="checkbox_label"><input id="worldscrawl_flag_tags" type="checkbox"> Let the narrator flag map changes (adds one short line to the prompt)</label>
      <label class="checkbox_label"><input id="worldscrawl_narrate_expiries" type="checkbox"> Narrate expiries (when a temporary place runs out with the party inside, pick where they end up, then the narrator tells it)</label>
      <label class="checkbox_label"><input id="worldscrawl_auto_keep_waits" type="checkbox"> Approve the narrator&apos;s waits without asking (skip the Approve / Adjust / Discard card)</label>
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
    const en = document.getElementById('worldscrawl_enabled');
    en.checked = isOn();
    en.addEventListener('change', () => setEnabled(en.checked));
    const enNew = document.getElementById('worldscrawl_enable_new');
    enNew.checked = !!settings().enableNewChats;
    enNew.addEventListener('change', () => { settings().enableNewChats = enNew.checked; ctx().saveSettingsDebounced(); applyChatState(); });
    const input = document.getElementById('worldscrawl_url');
    if (LEGACY_URL.test(settings().serverUrl || '')) settings().serverUrl = ''; // old Python default: the plugin now
    input.value = settings().serverUrl;
    input.addEventListener('input', () => { settings().serverUrl = input.value.trim(); exitsCache.clear(); ctx().saveSettingsDebounced(); });
    const who = document.getElementById('worldscrawl_who');
    who.value = settings().whoMoves ?? DEFAULTS.whoMoves;
    who.addEventListener('input', () => { settings().whoMoves = who.value; applyFacts(); ctx().saveSettingsDebounced(); });
    const showExits = document.getElementById('worldscrawl_show_exits');
    showExits.checked = !!settings().showExits;
    showExits.addEventListener('change', () => { settings().showExits = showExits.checked; ctx().saveSettingsDebounced(); renderAllExits(); });
    const autoKeep = document.getElementById('worldscrawl_auto_keep');
    autoKeep.checked = !!settings().autoKeep;
    autoKeep.addEventListener('change', () => { settings().autoKeep = autoKeep.checked; ctx().saveSettingsDebounced(); });
    const nex = document.getElementById('worldscrawl_narrate_expiries');
    nex.checked = settings().narrateExpiries !== false;
    nex.addEventListener('change', () => { settings().narrateExpiries = nex.checked; ctx().saveSettingsDebounced(); });
    const akw = document.getElementById('worldscrawl_auto_keep_waits');
    akw.checked = !!settings().autoKeepWaits;
    akw.addEventListener('change', () => { settings().autoKeepWaits = akw.checked; ctx().saveSettingsDebounced(); });
    const proDisc = document.getElementById('worldscrawl_proactive_discovery');
    proDisc.checked = !!settings().proactiveDiscovery;
    proDisc.addEventListener('change', () => { settings().proactiveDiscovery = proDisc.checked; ctx().saveSettingsDebounced(); discoveryChanged(); });
    const flagTags = document.getElementById('worldscrawl_flag_tags');
    flagTags.checked = !!settings().flagTags;
    flagTags.addEventListener('change', () => { settings().flagTags = flagTags.checked; applyNudge(); ctx().saveSettingsDebounced(); });
    document.querySelectorAll('input[name="worldscrawl_mode"]').forEach(r => {
        r.checked = r.value === settings().moveMode;
        r.addEventListener('change', () => { if (!r.checked) return; settings().moveMode = r.value; applyTools(); applyNudge(); applyFacts(); ctx().saveSettingsDebounced(); });
    });
    document.getElementById('worldscrawl_open_map').addEventListener('click', () => openMapWindow());
    document.getElementById('worldscrawl_test').addEventListener('click', () => { testConnection(); fillWorlds(); });
    const sel = document.getElementById('worldscrawl_world');
    sel.addEventListener('change', () => { settings().world = sel.value; ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_open_folder').addEventListener('click', () => openWorldFolder(''));
    document.getElementById('worldscrawl_open_world').addEventListener('click', () => openWorldFolder(sel.value || defaultWorldId || ''));
    document.querySelector('.worldscrawl_settings .inline-drawer-toggle')?.addEventListener('click', () => { refreshSaveName(); fillWorlds(); });
    document.getElementById('worldscrawl_save').addEventListener('click', () => saveWorld(document.getElementById('worldscrawl_save_name').value.trim() || document.getElementById('worldscrawl_save_name').placeholder, document.getElementById('worldscrawl_save_switch').checked, document.getElementById('worldscrawl_save_knowledge').checked, { confirm: true }).then(fillWorlds));
    fillWorlds();
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
    // Narrator generations that fail outright leave a 'narrator' failed note on the triggering message.
    let narrGen = null;
    const endNarr = () => { const p = narrGen; narrGen = null; const n = narratorFailure(p); if (n) { const len = ctx().chat?.length ?? 0; const at2 = p.type === 'swipe' ? len - 2 : len - 1; if (at2 >= 0) p.at = at2; noteCall(p.at, n); console.log(`[WorldScrawl] narrator failed on #${p.at}: ${n.reason}`); } };
    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, (type, opts, dry) => { if (narrGen) endNarr(); if (isOn()) { const p = narratorStart(ctx().chat, type, opts, dry); if (p) narrGen = p; } });
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => { if (narrGen) narrGen.stopped = true; });
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => { const p = narrGen; if (p) setTimeout(() => { if (narrGen === p) endNarr(); }, 800); });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => { if (narrGen) narrGen.received = true; });
    try {
        const tz = globalThis.toastr;
        if (tz?.error && !tz.error.__ws) { const orig = tz.error; tz.error = function (msg, title, ...r) { if (narrGen && !narrGen.error) narrGen.error = String([title, msg].filter(Boolean).join(': ')).replace(/<[^>]+>/g, '').slice(0, 160); return orig.call(this, msg, title, ...r); }; tz.error.__ws = true; }
    } catch { /* no toastr */ }
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, id => { stampExpiryReply(Number(id)).catch(e => console.error('[WorldScrawl] expiry stamp', e)); });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, id => { onReplyForFlags(Number(id)).catch(e => console.error('[WorldScrawl] flag', e)); });
    eventSource.on(eventTypes.CHAT_CHANGED, async () => { pendingLocation = null; expiryPending = null; snapCarriers(); await applyChatState(); });
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, () => { onMessagesDeleted().catch(e => console.error('[WorldScrawl] delete check', e)); });
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => { if (Number(id) === 0 && isOn()) ensureStartStamp().then(() => setTimeout(renderAllExits, 0)); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    for (const ev of ['MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderAllExits, 0));
    }
    for (const ev of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderStartButton, 0));
    }
    addSettingsPanel();
    addWandItem();
    try { mapChannel = openMapChannel(); } catch {}
    applyNudge();
    console.log('[WorldScrawl] loaded');
})();
