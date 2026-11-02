// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { render as P } from './prompts.mjs';
import { PLAYER } from './actors.mjs';
import { removeChange } from './carriers.mjs';
import { calendarLib, defaultWorldId, gameDate, listedWorlds, loadCalendar, placeWeatherNow, rememberWorlds, weatherLib, worldName, worldTimes } from './clock.mjs';
import { baseReply, gen } from './dig.mjs';
import { api, currentLocation, doorOverrides, doorStates, ensurePrompts, getStoredLocation } from './doors.mjs';
import { MAP_URL, NOT_RUNNING, PATCH_KEY, PLUGIN_URL, WAIT_KEY, activeWorld, baseUrl, broadcastMapState, ctx, isOn, mapVersion, refreshSaveName, revealPlaces, settings, syncWorld, waitCommand } from './index.js';
import { discoveredPlaces, lastUserIndex, revealedDoors, stoodInAddresses } from './movement.mjs';
import { changeEditMismatch, changeEditSession, liveEdit, mapCtx, opsHash, restampChange, swipeOf, toggleChange } from './patches.mjs';
import { exportNpc, mapActivity, mapInspect, mapNpcs, npcChatEdit } from './scene.mjs';
import { renderPatchCards } from './waits.mjs';

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

export { fillWorlds, openMapChannel, testConnection };
