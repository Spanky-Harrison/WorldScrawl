// The WorldScrawl window. Windows are registered in WINDOWS; the top bar gets one button per window.
// Live state comes from the extension over BroadcastChannel('worldscrawl'); room data from the plugin API.
import { buildGraph, knownRoom, layoutGraph, newRooms, hueFor, expandChanges, layerGraph, layerOf, layerKey, breadcrumb } from './mapdata.mjs';

const API = '/api/plugins/worldscrawl';
const channel = new BroadcastChannel('worldscrawl');
const NO_CHAT = 'Open a chat with WorldScrawl on in SillyTavern, and its map shows up here.';
let state = null; // latest {type:'state', ...} from the extension
const listeners = new Set();
const $ = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); } el.append(...kids); return el; };
const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const setStatus = t => { document.getElementById('status').textContent = t; };

// ---- Theme: the extension sends SillyTavern's live SmartTheme values; until then, read them from ST's saved settings.
const THEME_KEYS = { main_text_color: '--SmartThemeBodyColor', italics_text_color: '--SmartThemeEmColor', quote_color: '--SmartThemeQuoteColor',
    blur_tint_color: '--SmartThemeBlurTintColor', chat_tint_color: '--SmartThemeChatTintColor', border_color: '--SmartThemeBorderColor', shadow_color: '--SmartThemeShadowColor' };
export function applyTheme(vars) {
    for (const [k, v] of Object.entries(vars ?? {})) if (/^--[\w-]+$/.test(k) && typeof v === 'string' && v.trim()) document.documentElement.style.setProperty(k, v.trim());
}
let csrf = null;
async function csrfToken() {
    if (csrf) return csrf;
    try { csrf = (await (await fetch('/csrf-token')).json()).token; } catch {}
    return csrf;
}
async function themeFromSettings() {
    try {
        const r = await fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() }, body: '{}' });
        const pu = JSON.parse((await r.json()).settings ?? '{}').power_user ?? {};
        const vars = {};
        for (const [k, v] of Object.entries(THEME_KEYS)) if (pu[k]) vars[v] = pu[k];
        if (pu.chat_tint_color || pu.blur_tint_color) vars['--ws-bg'] = pu.chat_tint_color || pu.blur_tint_color;
        applyTheme(vars);
    } catch { /* keep the dark defaults */ }
}

// ---- Windows and the top bar.
const WINDOWS = [{ id: 'map', title: 'Map', create: createMapWindow }];
const openWindows = new Map();
function toggleWindow(def, force) {
    const on = force ?? !openWindows.has(def.id);
    const btn = document.querySelector(`[data-window="${def.id}"]`);
    if (on && !openWindows.has(def.id)) {
        const el = $('section', { class: 'wswindow', id: `window-${def.id}` }, $('h2', {}, def.title));
        document.getElementById('windows').append(el);
        openWindows.set(def.id, { el, api: def.create(el) });
    } else if (!on && openWindows.has(def.id)) { openWindows.get(def.id).el.remove(); openWindows.delete(def.id); }
    btn?.classList.toggle('active', on);
}
function buildTopBar() {
    const nav = document.getElementById('windowButtons');
    for (const def of WINDOWS) nav.append($('button', { class: 'topbutton', 'data-window': def.id, onclick: () => toggleWindow(def) }, def.title));
}

// ---- Room data, fetched in batches through the plugin API and remembered per world + map version.
const roomCache = new Map(); // world -> Map(address -> room)
const revealCache = new Map(); // world -> Map(door -> [reveal])
const worldStart = new Map(); // world -> start address (the world layer's layout root)
async function fetchRooms(world, addresses) {
    if (!roomCache.has(world)) roomCache.set(world, new Map());
    const cache = roomCache.get(world), missing = [...new Set(addresses)].filter(a => a && !cache.has(a));
    for (let i = 0; i < missing.length; i += 40) {
        const part = missing.slice(i, i + 40);
        const r = await fetch(`${API}/rooms?addresses=${encodeURIComponent(part.join(','))}${world ? `&world=${encodeURIComponent(world)}` : ''}`);
        if (!r.ok) throw new Error(`map server answered ${r.status}`);
        const b = await r.json();
        if (b.start) worldStart.set(world, b.start.address ?? b.start);
        for (const room of b.rooms ?? []) cache.set(room.address, room);
        for (const a of b.unknown ?? []) cache.set(a, null);
    }
    return cache;
}
async function fetchReveals(world, doors) {
    if (!revealCache.has(world)) revealCache.set(world, new Map());
    const cache = revealCache.get(world), missing = doors.filter(d => !cache.has(d));
    if (missing.length) {
        const r = await fetch(`${API}/doors${world ? `?world=${encodeURIComponent(world)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() }, body: JSON.stringify({ doors: missing }) });
        if (r.ok) { const b = await r.json(); for (const d of missing) cache.set(d, (b.exits ?? []).filter(x => x.door === d)); }
    }
    return doors.flatMap(d => cache.get(d) ?? []);
}
function noteVersion(st) { // the map files changed: forget remembered rooms
    const key = `${st.world}|${st.map_version}`;
    if (noteVersion.last && noteVersion.last !== key) { roomCache.clear(); revealCache.clear(); }
    noteVersion.last = key;
}
/** The known rooms (address -> room with this chat's reveals and changes) for a state message. */
export async function knownRooms(st) {
    noteVersion(st);
    const changes = st.changes ?? [];
    const dugTo = expandChanges(changes).filter(c => c.type === 'add_exit').map(c => c.to);
    const raw = new Map(await fetchRooms(st.world, [...st.stood, ...st.seen, st.location, ...dugTo]));
    for (const [a, v] of [...raw]) if (v === null) raw.delete(a);
    for (const [a, r] of newRooms(changes, raw)) raw.set(a, r);
    const reveals = await fetchReveals(st.world, st.doors_revealed ?? []);
    const out = new Map();
    for (const [a, r] of raw) out.set(a, knownRoom(r, { changes, reveals, rooms: raw }));
    return out;
}

// ---- Map window: three layers (world -> region -> subregion), breadcrumb in the top bar.
const NODE_W = 160, NODE_H = 46;
const savedLayout = key => { try { return JSON.parse(localStorage.getItem(`worldscrawl_layout:${key}`) ?? 'null'); } catch { return null; } };
const saveLayout = (key, pos) => { try { localStorage.setItem(`worldscrawl_layout:${key}`, JSON.stringify(Object.fromEntries(pos))); } catch {} };
function createMapWindow(win) {
    const body = $('div', { class: 'wsbody' }), view = $('div', { class: 'mapview' }), side = $('aside', { class: 'side' });
    win.append(body); body.append(view, side);
    const svg = S('svg'), world = S('g');
    svg.append(world);
    const legend = $('div', { class: 'legend' });
    const centre = $('button', { class: 'topbutton', title: 'Centre on where you are', onclick: () => { if (current) { setLayer(layerOf(current.full, current.here)); } } }, 'Centre');
    view.append(svg, legend, $('div', { class: 'mapbuttons' }, centre));
    let tf = { x: 0, y: 0, k: 1 }, current = null, selected = null, lastHere = null, lastKey = null, layer = null;
    const crumbs = document.getElementById('breadcrumb');
    const apply = () => world.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
    function centreOn(id) {
        const p = current?.pos.get(id);
        if (!p) return;
        const r = view.getBoundingClientRect();
        tf.x = r.width / 2 - p.x * tf.k; tf.y = r.height / 2 - p.y * tf.k; apply();
    }
    function setLayer(l) {
        layer = l; selected = null;
        if (current) { render(current.full, current.here, current.world); centreOn(current.graph.nodes.find(n => n.here)?.id ?? current.graph.nodes[0]?.id); }
    }
    // Pan (drag), zoom (wheel, pinch).
    const pointers = new Map(); let pinch = null, moved = false;
    const zoomAt = (cx, cy, f) => { const k = Math.min(3, Math.max(0.2, tf.k * f)); f = k / tf.k; tf.x = cx - (cx - tf.x) * f; tf.y = cy - (cy - tf.y) * f; tf.k = k; apply(); };
    view.addEventListener('wheel', ev => { ev.preventDefault(); const r = view.getBoundingClientRect(); zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY / 400)); }, { passive: false });
    view.addEventListener('pointerdown', ev => { pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); moved = false; view.classList.add('dragging'); });
    view.addEventListener('pointermove', ev => {
        const prev = pointers.get(ev.pointerId);
        if (!prev) return;
        const now = { x: ev.clientX, y: ev.clientY };
        pointers.set(ev.pointerId, now);
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), r = view.getBoundingClientRect();
            if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch);
            pinch = d; moved = true; return;
        }
        if (Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y) > 0) { tf.x += now.x - prev.x; tf.y += now.y - prev.y; apply(); }
        if (Math.hypot(now.x - prev.x, now.y - prev.y) > 2) moved = true;
    });
    const up = ev => { pointers.delete(ev.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) view.classList.remove('dragging'); };
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);

    function showSide(id) {
        selected = id;
        world.querySelectorAll('.node').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
        side.replaceChildren();
        const n = current?.graph.nodes.find(x => x.id === id);
        if (!n) { side.append($('p', { class: 'muted' }, 'Click a room to see its details.')); return; }
        if (n.kind === 'stub') { side.append($('h3', {}, n.name), $('p', { class: 'muted' }, "You haven't found out where this leads yet.")); return; }
        if (n.layer) { // an area (subregion or region), inside this layer or just outside it
            side.append($('h3', {}, n.name), $('div', { class: 'area' }, (n.level === 'region' ? 'Region' : 'Area') + (n.here ? ' · you are here' : n.kind === 'outside' ? ' · next to this map' : n.kind === 'seen' ? ' · seen, not visited' : '')));
            if (n.rooms?.length) side.append($('p', {}, `${n.rooms.length} known place${n.rooms.length === 1 ? '' : 's'}.`));
            side.append($('button', { class: 'topbutton open', onclick: () => setLayer(n.layer) }, `Open ${n.name}`), $('p', { class: 'muted' }, 'Double-click an area to open it.'));
            return;
        }
        side.append($('h3', {}, n.name), $('div', { class: 'area' }, [n.subregion.name, n.region].filter(Boolean).join(' · ') + (n.here ? ' · you are here' : n.kind === 'seen' ? ' · seen, not visited' : '')));
        if (n.description) side.append($('p', {}, n.description));
        const exits = current.graph.edges.flatMap(e => [e.from === id ? e : null, e.back?.from === id ? e.back : null].filter(Boolean));
        if (n.kind === 'stood') {
            side.append($('b', {}, 'Exits'));
            const ul = $('ul');
            for (const e of exits) {
                const to = e.from === id ? e.to : e.from, t = current.graph.nodes.find(x => x.id === to);
                ul.append($('li', {}, `${e.direction}${t && t.kind !== 'stub' ? ` → ${t.name}` : ''}${e.closed ? ' (closed door)' : ''}${e.dug ? ' (dug)' : ''}`));
            }
            if (!exits.length) ul.append($('li', { class: 'muted' }, 'none'));
            side.append(ul);
        } else side.append($('p', { class: 'muted' }, "You haven't been here yet."));
    }

    function render(full, here, worldId) {
        if (!layer) layer = layerOf(full, here);
        const graph = layerGraph(full, layer), key = `${worldId ?? ''}|${layerKey(layer)}`;
        const pos = layoutGraph(graph, { prev: savedLayout(key) });
        saveLayout(key, pos);
        current = { graph, pos, here, full, world: worldId };
        crumbs.replaceChildren(...breadcrumb(full, layer).flatMap((c, i, all) => [i ? $('span', { class: 'sep' }, '›') : '',
            $('button', { class: `crumb${i === all.length - 1 ? ' active' : ''}`, 'data-level': c.layer.level, onclick: () => setLayer(c.layer) }, c.label)]));
        world.replaceChildren();
        const at = id => pos.get(id);
        const subs = new Map();
        for (const e of graph.edges) {
            const a = at(e.from), b = at(e.to), g = S('g', { class: `edge${e.closed || e.back?.closed ? ' closed' : ''}` });
            if (!a || !b) continue;
            g.append(S('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
            const label = (t, f) => { if (!t) return; const el = S('text', { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - 4, 'text-anchor': 'middle' }); el.textContent = t; g.append(el); };
            label(e.direction, 0.3); if (e.back) label(e.back.direction, 0.7);
            world.append(g);
        }
        for (const n of graph.nodes) {
            const p = at(n.id), small = n.kind === 'stub' || n.kind === 'outside', hue = hueFor(n.subregion.id);
            const w = small ? 130 : NODE_W, h = small ? 30 : NODE_H;
            if (n.subregion.id && n.kind !== 'outside') subs.set(n.subregion.id, { name: n.subregion.name, hue });
            const g = S('g', { class: `node ${n.kind}${n.here ? ' here' : ''}${n.layer ? ' area' : ''}`, 'data-id': n.id, transform: `translate(${p.x},${p.y})` });
            g.append(S('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: n.layer ? 16 : 8, ...(n.kind !== 'stub' ? { fill: `hsl(${hue} 55% 45%)`, stroke: `hsl(${hue} 60% 60%)` } : {}) }));
            const sub2 = n.layer && n.kind !== 'outside' ? `${n.rooms.length} place${n.rooms.length === 1 ? '' : 's'}` : n.kind !== 'stub' && n.kind !== 'outside' ? n.subregion.name : '';
            const t = S('text', { 'text-anchor': 'middle', y: small || !sub2 ? 5 : -2 });
            const label = n.kind === 'stub' ? `${n.name} ?` : n.kind === 'outside' ? `→ ${n.name}` : n.name;
            t.textContent = label.length > 22 ? `${label.slice(0, 21)}…` : label;
            g.append(t);
            if (sub2) { const s2 = S('text', { 'text-anchor': 'middle', y: 15, style: 'font-size:10px;opacity:.7' }); s2.textContent = sub2.slice(0, 26); g.append(s2); }
            const title = S('title'); title.textContent = n.kind === 'stood' ? `${n.name} (been here)` : n.kind === 'seen' ? `${n.name} (seen, not visited)` : n.kind === 'outside' ? `${n.name} (double-click to open)` : `${n.name}: unexplored`; g.append(title);
            g.addEventListener('click', () => { if (!moved) showSide(n.id); });
            if (n.layer) g.addEventListener('dblclick', ev => { ev.stopPropagation(); setLayer(n.layer); });
            world.append(g);
        }
        legend.replaceChildren(...[...subs.values()].map(s => $('span', {}, $('i', { style: `background:hsl(${s.hue} 55% 45%)` }), s.name)),
            $('span', {}, '▭ been · ⋯ seen · ┄ closed door'));
        const hereNode = graph.nodes.find(n => n.here)?.id;
        showSide(graph.nodes.some(n => n.id === selected) ? selected : hereNode);
    }

    async function update(st) {
        if (!st || !st.on) { world.replaceChildren(); legend.replaceChildren(); crumbs.replaceChildren(); current = null; layer = null; side.replaceChildren($('p', { class: 'empty' }, NO_CHAT)); lastHere = null; return; }
        let rooms;
        try { rooms = await knownRooms(st); } catch (e) { side.replaceChildren($('p', { class: 'empty' }, `Could not load the map: ${e.message}`)); return; }
        if (st !== state) return; // a newer state arrived meanwhile
        const graph = buildGraph({ ...st, start: worldStart.get(st.world) ?? st.start }, rooms);
        const key = `${st.chatId}|${st.location}`, moved_ = key !== lastKey;
        if (moved_) layer = layerOf(graph, st.location); // follow the party: open the layer with the current room
        render(graph, st.location, st.world);
        if (moved_) { centreOn(current.graph.nodes.find(n => n.here)?.id); lastKey = key; } // auto-centre when the location (or chat) changes
        lastHere = st.location;
    }
    const fn = st => update(st);
    listeners.add(fn);
    if (state) update(state); else side.replaceChildren($('p', { class: 'empty' }, 'Waiting for SillyTavern…'));
    return { update };
}

// ---- Live sync.
function onState(st) {
    state = st;
    if (st.theme) applyTheme(st.theme);
    setStatus(st.on ? `${st.worldName ?? st.world ?? ''}${st.chatName ? ` · ${st.chatName}` : ''}` : 'No WorldScrawl chat');
    for (const fn of listeners) fn(st);
}
channel.addEventListener('message', ev => { if (ev.data?.type === 'state') onState(ev.data); });

buildTopBar();
toggleWindow(WINDOWS[0], true);
themeFromSettings();
channel.postMessage({ type: 'hello' });
setTimeout(() => { if (!state) { setStatus('SillyTavern not connected'); onState({ type: 'state', on: false }); state = null; } }, 2000);
