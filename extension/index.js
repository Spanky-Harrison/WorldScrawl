// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// the party's location; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// The party's location is stored on chat messages (message.extra.worldscrawl_location) so that
// deleting or swiping messages rolls the location back with them.
const MODULE = 'worldscrawl';
const LOC_KEY = 'worldscrawl_location';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: '', nudge: DEFAULT_NUDGE, showExits: true, moveMode: 'typed', whoMoves: '{{user}}', world: '', enableNewChats: false };
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
const FACTS_KEY = 'worldscrawl_facts';
const REMINDER_KEY = 'worldscrawl_arrival_reminder'; // depth 0: right after the latest user message
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
const rememberWorlds = body => {
    if (body?.default) defaultWorldId = body.default;
    if (body?.worlds) { listedWorlds.clear(); for (const w of body.worlds) { listedWorlds.add(w.id); missingWorlds.delete(w.id); worldNames.set(w.id, w.name); worldLiving.set(w.id, !!w.living); } }
};
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
    chat.forEach((m, i) => { const c = m?.extra?.[CHANGE_KEY]; if (c && i > from) out.push(...(Array.isArray(c) ? c : [c])); });
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
/** door id -> the open_door change, for doors open at the end of `chat`. */
export function doorStates(chat = ctx().chat ?? []) {
    const open = new Map();
    for (const m of chat) {
        for (const c of changesOf(m)) {
            if (c.type === 'open_door' && c.door) open.set(c.door, c);
            else if (c.type === 'close_door' && c.door) open.delete(c.door);
        }
        const ex = m?.extra ?? {};
        for (const p of [...(ex[MOVE_KEY]?.via ?? []), ex[LOC_KEY]].filter(Boolean))
            for (const [d, c] of open) { const rs = c.rooms ?? [c.from, c.to]; if (!c.stays_open && !rs.includes(roomToken(p)) && !rs.includes(p)) open.delete(d); }
    }
    return open;
}
/** What can be seen through an exit now: an opened door counts as "open". */
export const viewOf = (e, open = doorStates()) => (e?.view === 'closed' && e.door && open.has(e.door) ? 'open' : e?.view ?? 'open');
// rooms: opaque tokens of both sides of the door (from the server, even behind an obscured door, without saying
// where it leads); used only for the auto-close replay, never in a prompt.
const roomTokens = new Map(); // address -> room_token, filled as rooms are fetched
export const roomToken = a => roomTokens.get(a) ?? a;
export const doorChange = (type, here, e) => ({ type, from: here.address, direction: e.direction, door: e.door, rooms: e.door_rooms ?? [roomToken(here.address), ...(revealsDestination(e) && e.to ? [roomToken(e.to)] : [])], ...(type === 'open_door' ? { stays_open: !!e.stays_open } : {}) });
/** Closed doors here that can be opened / opened doors here that can be closed. */
export function doorCandidates(here, open = doorStates()) {
    const vis = here.exits.filter(e => e.door && (!e.hidden || revealsDestination(e)));
    return { toOpen: vis.filter(e => e.view === 'closed' && !open.has(e.door)), toClose: vis.filter(e => open.has(e.door)) };
}
/** /ws-open <dir>, /ws-close <dir> */
export async function doorAction(kind, arg) {
    const here = await currentLocation();
    const { toOpen, toClose } = doorCandidates(here);
    const list = kind === 'open' ? toOpen : toClose;
    const e = list.find(x => x.direction.toLowerCase() === String(arg ?? '').trim().toLowerCase());
    if (!e) { toastr.warning(list.length ? `Doors you can ${kind} here: ${list.map(x => x.direction).join(', ')}` : `No door to ${kind} here.`); return ''; }
    await addChangeMessage(`[Engine: the ${e.direction} door ${kind === 'open' ? 'is now open' : 'is now closed'}.]`, doorChange(kind === 'open' ? 'open_door' : 'close_door', here, e));
    return '';
}
export const cacheInfo = () => ({ size: exitsCache.size, mapVersion });
export const cacheKeys = () => [...exitsCache.keys()];

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
    syncWorld();
    await syncDoors();
    const stored = getStoredLocation();
    if (stored) {
        const loc = await fetchLocationCached(stored);
        if (loc) return loc;
        const r = await api(`/location/${encodeURIComponent(stored)}`).catch(() => null);
        if (r?.status === 404 && r.body?.detail?.error === 'world_not_found') { syncWorld(); const again = await fetchLocationCached(stored); if (again) return again; }
        else if (r?.status === 404) return missingRoomFallback(stored);
    }
    const start = await fetchLocationCached(null);
    if (!start) throw new Error(`WorldScrawl server not reachable at ${baseUrl()}, or /start failed. ${NOT_RUNNING()}`);
    return start;
}

/** The saved room isn't in this chat's world (edited away?): back to the start, with a short system notice that carries the new location (delete it to undo). */
async function missingRoomFallback(stored) {
    console.warn(`[WorldScrawl] location ${stored} is not in world ${activeWorld || '(default)'}; falling back to the start`);
    const start = await fetchLocationCached(null);
    if (!start) throw new Error('WorldScrawl: /start failed.');
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: `[Engine: that place no longer exists in this world. You are at ${displayName(start)}.]`,
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing', [LOC_KEY]: start.address } };
    c.chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    return start;
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
    if (!isOn()) { pendingLocation = null; return; }
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
    if (!toolsOn() || !isOn()) { TOOL_NAMES.forEach(n => { try { c.unregisterFunctionTool(n); } catch {} }); return; }
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
    const text = toolsOn() && isOn() ? String(settings().nudge ?? '').trim() : '';
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
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from: from.address, direction: String(direction).trim(), changes: chatChanges() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return { ok: false, error: d.error ?? `Move failed (${r.status})`, valid: d.valid_directions ?? from.exits.map(e => e.direction) };
    }
    primeCache(r.body);
    return { ok: true, to: r.body, move: { direction: exit?.direction ?? direction, prev_name: from.name, from: from.address, from_name: displayName(from), to: r.body.address, to_name: displayName(r.body) } };
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
    for (const a of worldSeed()?.stood ?? []) if ((await fetchRaw(a))) set.add(a); // seeded knowledge + stamps
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
    for (const a of stood) for (const v of (await fetchLocationCached(a))?.views ?? []) {
        if (!known.has(v.address)) { const l = await fetchRaw(v.address) ?? await newRoom(v.address); if (l) known.set(v.address, { address: v.address, name: l.name, display_name: displayName(l), subregion: l.subregion, region: l.region }); }
    }
    for (const a of worldSeed()?.seen ?? []) {
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
    const r = await api('/travel', { method: 'POST', body: JSON.stringify({ from: from.address, steps: steps.map(st => st.direction), changes: chatChanges() }) });
    if (!r.ok || !r.body?.path?.length) return { ok: false, error: r.body?.error ?? 'Route blocked.', valid: from.exits.map(e => e.direction) };
    r.body.path.forEach(primeCache);
    const at = r.body.location;
    const names = [displayName(from), ...r.body.path.map(displayName)];
    const via = r.body.path.map(l => l.address);
    if (r.body.stopped) console.warn(`[WorldScrawl] travel stopped at ${at.address} after ${r.body.steps_completed}/${steps.length} steps (${r.body.reason})`);
    const single = r.body.path.length === 1 ? steps[0].direction : null;
    const lastDir = steps[r.body.path.length - 1]?.direction ?? null;
    const prevName = (r.body.path.length > 1 ? r.body.path[r.body.path.length - 2] : from).name;
    return { ok: true, to: at, move: { direction: single, from: from.address, from_name: displayName(from), to: at.address, to_name: displayName(at), path: names, via, steps: steps.slice(0, r.body.path.length).map(st => st.direction), last_direction: lastDir, prev_name: prevName,
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
        const who = whoMoves();
        const note = moveNote(who, res.move, exit ?? here.exits.find(e => e.direction.toLowerCase() === String(res.move.direction ?? '').toLowerCase()));
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
const DIG_SYS = 'You help run a text adventure game. Answer exactly what is asked, as briefly as asked, and nothing else.';
export const DIG_TRIES = 2;
export const COMPASS = ['north', 'south', 'east', 'west', 'up', 'down'];
async function askValid(label, prompt, validate) {
    for (let i = 0; i < DIG_TRIES; i++) {
        const a = await ctx().generateRaw({ prompt, systemPrompt: DIG_SYS, responseLength: 60 });
        const v = validate(trimAnswer(cleanAnswer(a)));
        console.log(`[WorldScrawl] dig ${label} (try ${i + 1}): ${JSON.stringify(String(a).slice(0, 80))} -> ${v == null ? 'invalid' : JSON.stringify(v)}`);
        if (v != null) return v;
    }
    return null;
}
/** Rooms near `loc` over the map (any exit, hidden too; name/area/first sentence only), nearest first. */
async function nearbyRooms(loc) {
    const r = await api('/nearby', { method: 'POST', body: JSON.stringify({ from: loc.address, depth: 3, limit: 12, changes: chatChanges() }) });
    return r.ok ? r.body.rooms : [];
}
export const NEW_PLACE = 'somewhere new';
export function digDestPrompt(loc, said, rooms) {
    return `${whoMoves()} is in ${displayName(loc)}. ${loc.description ?? ''}\n${said}\n\n`
        + `The player is breaking a new opening. Places nearby:\n`
        + rooms.map((r, i) => `${i + 1}. ${r.display_name}: ${r.summary}`).join('\n') + `\n${rooms.length + 1}. ${NEW_PLACE}: a new space nobody has seen yet\n\n`
        + `Where does this opening most likely lead? Reply with just the number.`;
}
export function digDirPrompt(loc, said, destLabel, used) {
    return `${whoMoves()} is in ${displayName(loc)}.\n${said}\n\nThe player has made a new opening from here to ${destLabel}.\n`
        + `What is the opening called from this side? Use one of: ${COMPASS.join(', ')}, or a short new word (1-2 words) such as hole, crack, window, breach.\n`
        + `Already used here (do not use): ${used.join(', ') || 'none'}.\nReply with just the word.`;
}
export const digNamePrompt = (loc, said) => `${whoMoves()} is in ${displayName(loc)}.\n${said}\n\nThe opening leads to a new room. Name it in 2-3 words (like Dusty Crawlspace). Reply with just the name.`;
export const digDescPrompt = (loc, said, name) => `${whoMoves()} is in ${displayName(loc)}.\n${said}\n\nThe opening leads to a new room called ${name}. Describe it in one short sentence. Reply with just the sentence.`;
/** The 'new opening' intent: ask destination, direction, (new room) name and description; stamp the change on the player's message. */
async function narrativeDig(msg, loc) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const fail = why => { console.log(`[WorldScrawl] dig failed: ${why}`); msg.extra.worldscrawl_dig_failed = true; return { kind: 'dig_failed', loc }; };
    const rooms = await nearbyRooms(loc);
    const n = await askValid('destination', digDestPrompt(loc, said, rooms), a => {
        const m = a.match(/^(\d+)\b/); const i = m ? Number(m[1]) : (sameName(a, NEW_PLACE) ? rooms.length + 1 : rooms.findIndex(r => sameName(a, r.display_name) || sameName(a, r.name)) + 1);
        return i >= 1 && i <= rooms.length + 1 ? i : null;
    });
    if (n == null) return fail('no destination');
    const target = n <= rooms.length ? await fetchLocationCached(rooms[n - 1].address) : null;
    if (n <= rooms.length && !target) return fail('destination unknown');
    const used = loc.exits.filter(e => !e.hidden || e.revealed).map(e => e.direction); // never name a hidden exit in a prompt
    const direction = await askValid('direction', digDirPrompt(loc, said, target ? roomLabel(target) : 'a new space', used), a => {
        const d = a.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
        if (!/^[a-z][a-z'-]*( [a-z][a-z'-]*)?$/.test(d) || d.length > 20 || hasExit(loc, d)) return null;
        if (target && hasExit(target, returnName(d))) return null;
        return d;
    });
    if (direction == null) return fail('no direction');
    let dest = { address: target?.address };
    if (!target) {
        const name = await askValid('name', digNamePrompt(loc, said), a => {
            const t = a.replace(/\s+/g, ' ');
            const w = t.split(' ').length;
            return /^[A-Za-z][A-Za-z' -]*$/.test(t) && w <= 4 && t.length <= 40 && !sameName(t, loc.name) ? t.replace(/\b[a-z]/g, c => c.toUpperCase()) : null;
        });
        if (name == null) return fail('no name');
        const description = await askValid('description', digDescPrompt(loc, said, name), a => {
            const t = a.replace(/\s+/g, ' ').trim();
            return t.length >= 10 && t.length <= 200 ? (/[.!?]$/.test(t) ? t : t + '.') : null;
        });
        if (description == null) return fail('no description');
        dest = { name, description };
    }
    const r = await buildDig(loc, direction, dest, { description: 'A freshly broken opening.', returnDescription: 'A freshly broken opening.' });
    if (!r.ok) return fail(r.error);
    msg.extra[CHANGE_KEY] = r.change; // on the player's message, like a move: swipes keep it, deleting the message undoes it
    msg.extra.worldscrawl_dig = { direction: r.direction, back: r.back, to: r.to, to_name: r.label };
    // Biased toward moving: only a clean "yes" (they clearly stay on this side) keeps the party here; anything else goes through.
    const stayAns = await ctx().generateRaw({ prompt: digStayPrompt(said), systemPrompt: DIG_SYS, responseLength: 48 });
    const stays = parseYesNo(stayAns) === 'yes';
    console.log(`[WorldScrawl] dig stay-here: ${JSON.stringify(String(stayAns).slice(0, 80))} -> ${stays ? 'stay' : 'go through'}`);
    if (stays) return { kind: 'dig', loc };
    const res = await engineMove(r.direction); // the change is already on this message, so /move gets it via chatChanges()
    if (!res.ok) { console.warn(`[WorldScrawl] dig: moving through ${r.direction} failed: ${res.error}`); return { kind: 'dig', loc }; }
    stamp(msg, res.to, res.move); // dig first, then location = destination (both roll back with this message)
    return { kind: 'move', loc: res.to };
}
export const digStayPrompt = said => `${said}\n\nThe player has just made a new opening. Does the player clearly stay on this side (only making the opening, looking or reaching through)? Reply yes or no.`;
// ---- Looking and doors (the party never moves).
export const LOOK = 'look', OPEN_DOOR = 'open a door', CLOSE_DOOR = 'close a door';
export const LOOK_RE = /\b(?:look|looks|looked|looking|peer|peers|peered|peering|peek|peeks|peeked|peeking|gaze|gazes|gazed|gazing|glance|glances|glanced|glancing|listen|listens|listened|listening|watch|watches|watched|watching|see|sees|saw|seeing)\b/i;
export const DOOR_OPEN_RE = /\b(?:open|opens|opened|opening|unlatch\w*|unbar\w*)\b/i;
export const DOOR_CLOSE_RE = /\b(?:close|closes|closed|closing|shut|shuts|shutting|slam|slams|slammed|slamming)\b/i;
export const NO_EXIT = 'out a window or opening with no exit';
const exitTargetLabel = e => `the ${e.direction} exit${revealsDestination(e) ? ` (to ${destLabel(e)})` : ''}`;
export const AROUND = 'around here in general, nothing specific';
export const WINDOW_WORD_RE = /\b(?:windows?|shutters?|outside|outdoors|openings?|balcon(?:y|ies)|portholes?|skylights?)\b/i;
/** Offer the window option only when the player mentions one, or the room already has a view. */
export const offerWindow = (loc, text) => WINDOW_WORD_RE.test(String(text ?? '')) || (loc.views ?? []).length > 0;
/** Options: 1 = around, then the exits, then (maybe) the window, last. */
export function lookTargetPrompt(loc, said, exits, withWindow = true) {
    const opts = [AROUND, ...exits.map(exitTargetLabel), ...(withWindow ? [NO_EXIT] : [])];
    return `${whoMoves()} is in ${displayName(loc)}.\n${said}\n\nWhat is the player looking at or listening to?\n`
        + opts.map((o, i) => `${i + 1}. ${o}`).join('\n') + '\n\nReply with just the number.';
}
export const DOOR_LOOK = ['listen', 'peek', 'open', 'look'];
export const closedDoorPrompt = (said, e) => `${said}\n\nThe ${e.direction} door is closed. What does the player do with it?\n1. only listens at it\n2. peeks through it (a crack, keyhole or gap) without opening it\n3. opens it\n4. just looks at the closed door\n\nReply with just the number.`;
export function viewPickPrompt(loc, said, rooms) {
    return `${whoMoves()} is in ${displayName(loc)}. ${loc.description ?? ''}\n${said}\n\nThe player looks out of a window or opening. Places nearby:\n`
        + rooms.map((r, i) => `${i + 1}. ${r.display_name}: ${r.summary}`).join('\n') + `\n\nWhich place can they most likely see? Reply with just the number.`;
}
const pickNumber = n => a => { const m = String(a).match(/^(\d+)\b/); const i = m ? Number(m[1]) : 0; return i >= 1 && i <= n ? i : null; };
/** The 'look' intent: pick an exit (or a window), then see / hear / nothing. Stamps door and view-link changes on the message. */
async function narrativeLook(msg, loc) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exits = loc.exits.filter(e => !e.hidden || revealsDestination(e)); // an unrevealed hidden exit is never named
    const stampChange = c => { msg.extra[CHANGE_KEY] = [...changesOf(msg), c]; };
    let look;
    if (LOOK_AROUND_RE.test(String(msg.mes ?? ''))) look = { kind: 'around' }; // 'I look around': no question, no view link
    const win = !look && offerWindow(loc, msg.mes);
    const n = look ? null : await askValid('look target', lookTargetPrompt(loc, said, exits, win), pickNumber(exits.length + 1 + (win ? 1 : 0)));
    if (look) { /* around */ }
    else if (n == null) look = { kind: 'nothing' };
    else if (n === 1) look = { kind: 'around' };
    else if (n <= exits.length + 1) {
        const e = exits[n - 2];
        let v = viewOf(e), opened = false;
        if (v === 'closed') {
            const k = await askValid('closed door', closedDoorPrompt(said, e), pickNumber(4));
            const act = DOOR_LOOK[(k ?? 4) - 1]; // unreadable: just looking (never opens a door by accident)
            if (act === 'listen') v = 'listen';
            else if (act === 'open') { stampChange(doorChange('open_door', loc, e)); opened = true; v = 'open'; }
            else if (act === 'peek') { msg.extra.worldscrawl_peek = { type: 'peek', door: e.direction, from: loc.address }; v = 'peek'; } // no effect on door state (for a later stealth mechanic)
            else v = 'shut';
        }
        const t = (v === 'open' || v === 'peek') && revealsDestination(e) && e.to ? await fetchLocationCached(e.to) : null;
        look = v === 'listen' ? { kind: 'listen', via: e.direction }
            : v === 'shut' ? { kind: 'closed', via: e.direction }
            : t ? { kind: 'see', via: e.direction, to: t.address, name: displayName(t), description: t.description, opened, ...(v === 'peek' ? { peek: true } : {}) }
            : { kind: 'nothing', via: e.direction, opened };
    } else {
        let view = (loc.views ?? [])[0]; // hand-written views first, then an earlier view link: the same answer every time
        if (!view) {
            const rooms = await nearbyRooms(loc);
            const k = rooms.length ? await askValid('view', viewPickPrompt(loc, said, rooms), pickNumber(rooms.length)) : null;
            if (k != null) { view = rooms[k - 1]; stampChange({ type: 'view_link', from: loc.address, to: view.address }); }
        }
        const t = view ? await fetchLocationCached(view.address) : null;
        look = t ? { kind: 'see', window: true, to: t.address, name: displayName(t), description: t.description } : { kind: 'nothing', window: true };
    }
    if (!changesOf(msg).length) delete msg.extra[CHANGE_KEY];
    msg.extra.worldscrawl_look = look;
    console.log(`[WorldScrawl] look: ${JSON.stringify(look).slice(0, 160)}`);
    return { kind: 'look', loc };
}
/** The open/close door intents: which door (asked only if several), stamped on the message. */
async function narrativeDoor(msg, loc, list, type) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    let e = list.length === 1 ? list[0] : null;
    if (!e) {
        const k = await askValid('door', `${whoMoves()} is in ${displayName(loc)}.\n${said}\n\nWhich door does the player ${type === 'open_door' ? 'open' : 'close'}?\n` + list.map((x, i) => `${i + 1}. ${exitTargetLabel(x)}`).join('\n') + '\n\nReply with just the number.', pickNumber(list.length));
        e = k ? list[k - 1] : null;
    }
    if (!e) return { kind: STAY, loc };
    msg.extra[CHANGE_KEY] = [...changesOf(msg), doorChange(type, loc, e)];
    msg.extra.worldscrawl_door = { type, direction: e.direction };
    return { kind: 'door', loc };
}
export const DIG_FAILED_NOTICE = 'Nothing gave way: no new opening was made.';

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
    const canOpen = BREAK_RE.test(msg.mes ?? ''); // the 'new opening' choice is only offered when the player uses a breaking-through word
    const canLook = LOOK_RE.test(msg.mes ?? '');
    const doors = doorCandidates(loc);
    const canOpenDoor = DOOR_OPEN_RE.test(msg.mes ?? '') && doors.toOpen.length > 0, canCloseDoor = DOOR_CLOSE_RE.test(msg.mes ?? '') && doors.toClose.length > 0;
    const extras = [...(canOpen ? [OPEN] : []), ...(canLook ? [LOOK] : []), ...(canOpenDoor ? [OPEN_DOOR] : []), ...(canCloseDoor ? [CLOSE_DOOR] : [])];
    const options = [...dirs, ...places.map(p => p.label), ...extras, STAY, ELSEWHERE, UNCLEAR];
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exitLines = exitLabels(loc.exits, n => n).map((lbl, i) => {
        const e = loc.exits[i];
        const nm = lbl.length > e.direction.length ? lbl.slice(e.direction.length) : destLabel(e); // same label as the footer: room, or building (+ room / region)
        return `- ${e.direction}${revealsDestination(e) ? ` (to ${nm}${e.to === prev ? ', where you came from' : ''})` : ''}`;
    });
    const prompt = `${whoMoves()} is at ${displayName(loc)}. Its exits are:\n${exitLines.join('\n') || '- (none)'}\n\n`
        + `${said}\n\nAnswer with one option:\n`
        + dirs.map(d => `- ${d}: the player goes through the "${d}" exit right now\n`).join('')
        + places.map(p => `- ${p.label}: the player travels to ${p.label}, a place they know about\n`).join('')
        + (canOpen ? `- ${OPEN}: the player clearly breaks through a wall, floor, ceiling or window right now, making a new opening (not just hitting, kicking or touching it)\n` : '')
        + (canLook ? `- ${LOOK}: the player looks, peers, peeks or listens at something from here, without going anywhere\n` : '')
        + (canOpenDoor ? `- ${OPEN_DOOR}: the player opens a closed door here, without going through it\n` : '')
        + (canCloseDoor ? `- ${CLOSE_DOOR}: the player closes an open door here\n` : '')
        + `- ${STAY}: the player is not trying to travel anywhere\n`
        + `- ${ELSEWHERE}: the player wants to go to a place that is not listed above\n`
        + `- ${UNCLEAR}: the player wants to travel, but it is unclear which of the listed places they mean\n\n`
        + `Which option: ${options.join(', ')}? Reply with exactly one option from that list.`;
    const answer = await c.generateRaw({ prompt, systemPrompt: SYS, responseLength: 48 });
    const cands = await travelCandidates(loc);
    // Without the word check passing, "new opening" is not an option: such an answer falls through to the normal handling.
    let choice = parseIntentAnswer(answer, [...dirs, ...places.map(p => p.label), ...extras]);
    if (choice === OPEN) return await narrativeDig(msg, loc);
    if (choice === LOOK) return await narrativeLook(msg, loc);
    if (choice === OPEN_DOOR || choice === CLOSE_DOOR) return await narrativeDoor(msg, loc, choice === OPEN_DOOR ? doors.toOpen : doors.toClose, choice === OPEN_DOOR ? 'open_door' : 'close_door');
    const ans = trimAnswer(cleanAnswer(answer));
    const insideAns = !dirs.includes(choice) && hereAreas(loc).find(a => sameName(a.name, choice ?? ans));
    if (insideAns) return { kind: 'already', loc, name: insideAns.name };
    if (!choice) { // a bare name that matches known places (e.g. "Upstairs Rooms")
        const m = matchCandidates(trimAnswer(cleanAnswer(answer)), cands);
        if (m.length > 1) return { kind: 'which', loc, candidates: m };
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
    }
    if (!choice) {
        const yn = await c.generateRaw({ prompt: `${whoMoves()} is at ${loc.name}.\n${said}\n\nIs the player trying to travel to a different place? Answer yes or no.`, systemPrompt: 'Reply with exactly one word: yes or no.', responseLength: 48 });
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
    return `[Engine: this turn ends in ${where}. Do not narrate entering any other room. If the player's message assumes they arrive somewhere else or do things there, they actually stopped in ${where}. Keep their intent where it fits (they may notice or want the other place), but do not narrate them reaching it.]`;
}

/** "out", "up", "north"...: a direction, not a thing you can look through. */
export const isDirWord = d => PLAIN_DIRECTIONS.has(String(d ?? '').toLowerCase());
const doorWord = d => (isDirWord(d) ? `door (${d})` : d);
/** One line per thing visible from here: open exits (glimpse of the room beyond) and window views. */
export function glimpseLines(loc, open = new Map()) {
    const out = [];
    for (const e of loc.exits ?? []) if (viewOf(e, open) === 'open' && revealsDestination(e) && e.to_summary) out.push(`${isDirWord(e.direction) ? `Looking ${e.direction}` : `Through the ${e.direction}`}, you can see ${e.to_label ?? e.to_display_name ?? e.to_name}: ${e.to_summary}`);
    for (const v of loc.views ?? []) out.push(`Visible from here (no way through): ${v.display_name}: ${v.summary}`);
    return out;
}
export function lookText(who, here, look) {
    const how = look.window ? 'out' : look.via ? (isDirWord(look.via) ? look.via : `through the ${look.via}`) : 'around';
    const first = look.opened ? `${who} opens the ${doorWord(look.via)} first. ` : '';
    if (look.kind === 'see' && look.peek) return `What just happened: ${who} peeks through the closed ${doorWord(look.via)} without opening it and glimpses ${look.name}: ${look.description} The door stays closed. ${who} is still at ${here}. Describe only the glimpse.`;
    if (look.kind === 'see') return `What just happened: ${first}${who} looks ${how} and sees ${look.name}: ${look.description} ${who} does not go there and is still at ${here}. Describe only what can be seen from here.`;
    if (look.kind === 'closed') return `What just happened: ${who} looks at the ${doorWord(look.via)}. The door is closed; nothing beyond it can be seen. ${who} stays at ${here}.`;
    if (look.kind === 'listen') return `What just happened: ${who} listens at the closed ${doorWord(look.via)}. Only faint, muffled sounds come from beyond it; nothing can be made out clearly. ${who} stays at ${here}.`;
    return `What just happened: ${first}${who} looks ${how}, but nothing can be made out beyond it. ${who} stays at ${here}.`;
}
export const EXITS_HINT = 'In this reply, mention every exit listed above, and weave in what can be seen through the open ones (the "you can see" lines). For an exit listed without a destination, mention only the exit itself; do not hint or guess where it leads.';
export const LOOK_AROUND_RE = /\b(?:look(?:s|ed|ing)?|glanc(?:e|es|ed|ing)|gaz(?:e|es|ed|ing)|peer(?:s|ed|ing)?)\s+(?:around|about|round)\b|\b(?:survey(?:s|ed|ing)?|take(?:s)? in) (?:the|my|our) surroundings\b/i;
export function factsText(loc, move, toolsOn, extra = {}) {
    const who = whoMoves();
    const lines = [
        '[World state from the game engine. This is authoritative.]',
        `Current location: ${loc.name}${loc.subregion?.name && loc.subregion.name !== loc.name ? `, ${loc.subregion.name}` : ''}${loc.region?.name ? ` (${loc.region.name})` : ''}`,
        loc.effective_notes?.region ? `About ${loc.region?.name ?? 'the region'}: ${loc.effective_notes.region}` : '',
        loc.effective_notes?.subregion ? `About ${loc.subregion?.name ?? 'this area'}: ${loc.effective_notes.subregion}` : '',
        `This location: ${loc.description ?? ''}`,
        (loc.effective_notes?.region || loc.effective_notes?.subregion) ? 'If this location\'s own description contradicts the broader notes above, the location description wins.' : '',
        exitsText(loc).replace(/^Exits:/, 'Exits from here:'),
        ...glimpseLines(loc, extra.open),
    ];
    const arr = move && move.to === loc.address ? arrival(loc, move) : null;
    if (extra.dig && move && move.to === loc.address) lines.push(`What just happened: ${who} broke through, making a new opening (${extra.dig.direction}) from ${move.from_name}, and went straight through it.${arr ? ` ${who} ${arr.text}.` : ''} Narrate breaking through and arriving in ${arr?.where ?? move.to_name}.`);
    else if (move?.path?.length > 2) lines.push(`What just happened: ${who} travelled from ${move.path[0]} through ${move.path.slice(1, -1).join(', ')} to ${move.to_name}${move.stopped ? ' (the trip was cut short there)' : ''}.${arr ? ` ${who} ${arr.text}.` : ''} Narrate the journey briefly, in that order, ending with arriving in ${arr?.where ?? move.to_name}.`);
    else if (move) lines.push(`What just happened: ${who} moved ${move.direction} from ${move.from_name} to ${move.to_name}.${arr ? ` ${who} ${arr.text}.` : ''} Describe arriving in ${arr?.where ?? move.to_name}.`);
    else if (extra.look && extra.look.kind !== 'around') lines.push(lookText(who, displayName(loc), extra.look));
    else if (extra.door) lines.push(`What just happened: ${who} ${extra.door.type === 'open_door' ? 'opens' : 'closes'} the ${doorWord(extra.door.direction)}${isDirWord(extra.door.direction) ? '' : ' door'}. ${who} stays at ${displayName(loc)}.`);
    else if (extra.dig) lines.push(`What just happened: ${who} broke through, making a new opening (${extra.dig.direction}) from here to ${extra.dig.to_name}. It exists now and is listed in the exits. ${who} has not gone through it yet and is still at ${displayName(loc)}. Narrate the breakthrough.`);
    else if (extra.digFailed) lines.push(`What just happened: ${who} tried to break through, but nothing gave way. No new opening exists. ${who} is still at ${displayName(loc)}. Narrate the attempt failing.`);
    else if (extra.lookAround || extra.look?.kind === 'around') lines.push(`What just happened: ${who} looks around ${displayName(loc)}. ${who} stays here.`);
    else lines.push(`${who} has NOT moved this turn and is still at ${displayName(loc)}. Do not narrate travel to any other place.`);
    if ((move && move.to === loc.address) || ((extra.lookAround || extra.look?.kind === 'around') && !move)) lines.push(EXITS_HINT);
    lines.push(toolsOn
        ? 'Do not invent locations or exits that are not listed.'
        : `You only narrate. The game engine controls movement: never move ${who} to a different location yourself, and do not invent locations or exits that are not listed. If a character tries to leave some other way, describe why they cannot.`);
    return lines.filter(Boolean).join('\n');
}

async function applyFacts() {
    const c = ctx();
    if (!isOn()) { c.setExtensionPrompt(FACTS_KEY, '', 1, 1, false, 0); c.setExtensionPrompt(REMINDER_KEY, '', 1, 0, false, 0); return; }
    let text = '', reminder = '';
    try {
        const loc = await currentLocation();
        const ui = lastUserIndex(c.chat ?? []);
        const move = ui >= 0 ? c.chat[ui].extra?.[MOVE_KEY] : null;
        const um = ui >= 0 ? c.chat[ui].extra ?? {} : {};
        text = factsText(loc, move, toolsOn(), { dig: um.worldscrawl_dig, digFailed: um.worldscrawl_dig_failed, look: um.worldscrawl_look, lookAround: ui >= 0 && LOOK_AROUND_RE.test(c.chat[ui].mes ?? '') && !(um.worldscrawl_look && (um.worldscrawl_look.via || um.worldscrawl_look.window)), door: um.worldscrawl_door, open: doorStates() });
        reminder = arrivalReminder(loc, move);
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
    if (type === 'quiet' || type === 'impersonate' || !isOn()) return;
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
            if (r.kind === 'dig_failed') toastr.warning(`WorldScrawl: ${DIG_FAILED_NOTICE}`);
            renderAllExits();
        }
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
    if (withKnowledge) { // what this chat knows, for new chats on the saved world (written to knowledge.json)
        const here = await currentLocation();
        const stood = [...await stoodInAddresses()];
        const seen = [...(await discoveredPlaces()).keys()].filter(a => !stood.includes(a));
        knowledge = { location: here.address, stood, seen, doors: [...await syncDoors()] };
    }
    const body = { base: activeWorld || null, name, auto, ...(auto ? { id_hint: autoIdHint() } : {}), changes: chatChanges(), ...(knowledge ? { knowledge } : {}) };
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
        name: 'ws-known',
        callback: whenOn(async () => { try { const t = await knownText(); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        helpString: 'WorldScrawl: list the places this chat knows: where you have been, and places seen but not visited.',
    }));
}

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
const ck = (a, w = activeWorld || defaultWorldId || '') => `${w}|${a ?? '(start)'}`;

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
        try { const r = await api(`/rooms?addresses=${encodeURIComponent(missing.join(','))}`); return r.ok ? r.body : null; } catch { return null; }
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

async function renderAllExits() {
    broadcastMapState();
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
/** The state the map window shows: this chat's world, where the party is, what it knows, open doors and changes. */
export async function mapState() {
    const c = ctx();
    const base = { type: 'state', chatId: c.chatId ?? c.getCurrentChatId?.() ?? null, chatName: c.name2 ?? '', theme: themeVars() };
    if (!isOn() || !base.chatId) return { ...base, on: false };
    syncWorld();
    const stood = [...await stoodInAddresses()];
    const seen = [...(await discoveredPlaces()).keys()].filter(a => !stood.includes(a));
    const here = await currentLocation();
    return { ...base, on: true, world: activeWorld || defaultWorldId || '', worldName: worldName(activeWorld), map_version: mapVersion,
        location: here?.address ?? null, stood, seen, doors_revealed: [...revealedDoors], doors_open: [...doorStates().keys()], changes: chatChanges() };
}
let broadcastTimer = null;
export function broadcastMapState() {
    if (typeof BroadcastChannel === 'undefined') return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(async () => {
        try { mapChannel ??= openMapChannel(); mapChannel.postMessage(await mapState()); } catch (e) { console.warn('[WorldScrawl] map broadcast failed', e); }
    }, 150);
}
function openMapChannel() {
    const ch = new BroadcastChannel('worldscrawl');
    ch.addEventListener('message', ev => { if (ev.data?.type === 'hello') broadcastMapState(); });
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
    eventSource.on(eventTypes.CHAT_CHANGED, async () => { pendingLocation = null; await applyChatState(); });
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
