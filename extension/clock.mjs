// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { api } from './doors.mjs';
import { fetchRaw, newRoom, renderAllExits } from './footer.mjs';
import { CHANGE_KEY, WORLD_KEY, activeWorld, baseUrl, ctx, isOn } from './index.js';
import { displayName } from './movement.mjs';
import { patchesOn } from './patches.mjs';
 // '' = server default
let defaultWorldId = null; // learned from GET /worlds; '' and the default id are the same world
const worldNames = new Map(); // id -> display name (from GET /worlds and saves)
const worldLiving = new Map(); // id -> true for living saves (can be saved over)
const listedWorlds = new Set(); // ids in the latest GET /worlds (the server rescans its folder on each list)
const missingWorlds = new Set(); // world ids the server says no longer exist
const worldTimes = new Map(); // id -> {calendar, start_date} (from GET /worlds and saves)
const worldCasts = new Map(); // id -> { npcs, places: Set, names, labels }
const rememberWorlds = body => {
    if (body?.default) defaultWorldId = body.default;
    if (body?.worlds) { listedWorlds.clear(); for (const w of body.worlds) { listedWorlds.add(w.id); missingWorlds.delete(w.id); worldNames.set(w.id, w.name); worldLiving.set(w.id, !!w.living); if (w.start_date) worldTimes.set(w.id, { calendar: w.calendar, start_date: w.start_date, weather: w.weather }); if (Array.isArray(w.cast)) worldCasts.set(w.id, { npcs: w.cast, places: new Set(w.places ?? []), subs: new Set(w.subs ?? []), regions: new Set(w.regions ?? []), elsewhere: w.elsewhere ?? [], names: w.place_names ?? [], labels: w.place_labels ?? {} }); } }
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
} // is the Save box placeholder a generated name (vs. the living world's own name)?
/** What the user sees for a world: its display name, else its id. */
export const worldName = id => worldNames.get(id || defaultWorldId) ?? (id || defaultWorldId || 'World');
export function chatWorld(chat = ctx().chat ?? []) {
    for (let i = chat.length - 1; i >= 0; i--) { const w = chat[i]?.extra?.[WORLD_KEY]; if (w?.id) return { ...w, index: i }; }
    return null;
}
/** Knowledge seeded from a "with knowledge" world when this chat started (on message 0, so swipes keep it). */
export function worldSeed(chat = ctx().chat ?? []) {
    for (const m of chat) { const sd = m?.extra?.[WORLD_KEY]?.seed; if (sd) return sd; }
    return null;
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

export { applyChanges, calendarLib, defaultWorldId, listedWorlds, rememberWorlds, weatherLib, worldCasts, worldLiving, worldMissing, worldNames, worldTimes };
