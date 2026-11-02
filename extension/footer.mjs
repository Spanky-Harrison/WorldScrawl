// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { timeLabel } from './timelabels.mjs';
import { PLAYER, positionOf } from './actors.mjs';
import { presentAt } from './npc.mjs';
import { applyChanges, calendarLib, chatChanges, clockAt, defaultWorldId, gameDate, loadCalendar, placeWeatherNow, worldTimes } from './clock.mjs';
import { api, roomTokens } from './doors.mjs';
import { WORLD_KEY, activeWorld, broadcastMapState, ctx, goTarget, isOn, moveChatToWorld, settings, syncWorld } from './index.js';
import { applyReveals, chatAddresses, exitLabels, placeLabel, syncDoors } from './movement.mjs';
import { mapCtx, patchSig, relocateFrom } from './patches.mjs';
import { castPack, npcEnv } from './scene.mjs';
import { renderPatchCards } from './waits.mjs';

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
        region: near?.region ?? {}, subregion: sub, effective_lore: near?.effective_lore ?? {}, new_room: true };
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
    const who = namedNpcsAt(ch, id, loc);
    if (who.length) { const n = document.createElement('div'); n.className = 'worldscrawl_npcs_here'; n.textContent = `Named NPCs present: ${who.join(', ')}`; div.append(n); }
    (fresh.querySelector('.mes_block') ?? fresh).appendChild(div);
}
/**
 * Display only (the exits footer, never the prompt): the carded people the engine places with the player at message
 * `id` (same presentAt as the people-here block, followers included), by the name the player knows or unknownAs.
 */
export function namedNpcsAt(chat, id, loc) {
    const pack = castPack();
    if (!pack?.npcs?.length || !calendarLib || !chat?.[id]) return [];
    try {
        return presentAt(chat, id, pack.npcs, npcEnv(chat, loc)).map(p => (p.known?.known === false && p.unknownAs ? p.unknownAs : p.name)).filter(Boolean);
    } catch (e) { console.warn('[WorldScrawl] npcs footer', e.message); return []; }
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

export { exitsCache, fetchLocationCached, fetchRaw, locationAt, newRoom, primeCache, renderAllExits, renderStartButton, warmRooms };
