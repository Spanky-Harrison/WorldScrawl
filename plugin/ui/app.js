// The WorldScrawl window. Windows are registered in WINDOWS; the top bar gets one button per window.
// Live state comes from the extension over BroadcastChannel('worldscrawl'); room data from the plugin API.
import { placeWeather, fmtTemp } from './weather.mjs';
import { buildEditForm, expandPrompt } from './placeform.mjs';
import { actionsFor, openAction } from './mapactions.mjs';
import { renderDiff, renderMoves, moveGroups } from './diffview.mjs';
import { pickSearch, pickValid, pathOf } from './picker.mjs';
import { buildGraph, knownRoom, layoutGraph, newRooms, hueFor, expandChanges, layerGraph, layerOf, layerKey, breadcrumb } from './mapdata.mjs';

const API = '/api/plugins/worldscrawl';
const channel = new BroadcastChannel('worldscrawl');
const NO_CHAT = 'Open a chat with WorldScrawl on in SillyTavern, and its map shows up here.';
let state = null; // latest {type:'state', ...} from the extension
const listeners = new Set();
const $ = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false)); return el; };
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
    // Wait: the map never changes state itself; it asks the SillyTavern tab to post a stamped wait message.
    const waitSel = $('select', { class: 'topbutton', id: 'waitPick', title: 'Pass time here without moving (posts a message in the chat; delete it to undo)', onchange: ev => {
        const [kind, args] = String(ev.target.value).split('|'); ev.target.value = '';
        if (!kind || !state?.on || !state.chatId) return;
        channel.postMessage({ type: 'wait', chatId: state.chatId, sleep: kind === 'sleep', args });
    } }, $('option', { value: '' }, 'Wait…'), $('option', { value: 'wait|1h' }, 'Wait 1 hour'), $('option', { value: 'wait|until morning' }, 'Wait until morning'), $('option', { value: 'sleep|8h' }, 'Sleep 8 hours'));
    nav.append(waitSel);
    nav.append($('button', { class: 'topbutton editor-toggle', id: 'editorToggle', title: 'Editor mode: see the whole world and inspect its data (read-only)', onclick: () => setEditor(!editor) }, 'Editor'));
}

// ---- Editor mode (read-only inspector): the whole world is shown, and clicking anything shows its data.
let editor = false;
try { editor = localStorage.getItem('worldscrawl_editor') === '1'; } catch {}
function setEditor(on) {
    editor = on;
    try { localStorage.setItem('worldscrawl_editor', on ? '1' : '0'); } catch {}
    document.getElementById('editorToggle')?.classList.toggle('active', on);
    document.body.classList.toggle('editor', on);
    for (const fn of listeners) fn(state);
}
const indexCache = new Map(); // world|version -> {addresses, doors}
/** This chat's map patches (fire, collapse...): when there are any, map requests send the chat's changes. */
const patchesOf = st => (st?.changes ?? []).filter(c => c?.type === 'patch');
/** Rooms a chat change touched (for the small marker on the map). */
export const patchedRooms = st => {
    const out = new Set();
    for (const p of patchesOf(st)) {
        for (const o of p.ops ?? []) for (const a of [o.loc, o.into, ...(Array.isArray(o.locs) ? o.locs : [])]) if (typeof a === 'string' && a.includes('/')) out.add(a);
        for (const o of p.ops ?? []) if (typeof o.area === 'string' && o.area && !o.op?.startsWith('add')) out.add(`area:${o.area}`); // region / subregion edits
        for (const [a, b] of Object.entries(p.relocate ?? {})) { out.add(a); out.add(b); }
    }
    return out;
};
/** "Edit live": the map asks the SillyTavern tab to stamp the edit on a hidden message; it answers with patch_result. */
const pendingEdits = new Map();
function sendLiveEdit(ops) {
    const req = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise(resolve => {
        const t = setTimeout(() => { pendingEdits.delete(req); resolve({ ok: false, errors: [{ i: null, error: 'No answer from SillyTavern. Is the chat open in a tab?' }] }); }, 15000);
        pendingEdits.set(req, r => { clearTimeout(t); resolve(r); });
        channel.postMessage({ type: 'patch', chatId: curState?.chatId, req, ops });
    });
}
/** Turn off / Turn on from the inspector's Changes tab: the SillyTavern tab runs it (same flow as its cards) and answers. */
const pendingToggles = new Map();
function sendRemove(msg, id, choice) {
    const req = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise(resolve => {
        const t = setTimeout(() => { pendingToggles.delete(req); resolve({ ok: false, error: 'No answer from SillyTavern. Is the chat open in a tab?' }); }, 15000);
        pendingToggles.set(req, r => { clearTimeout(t); pendingToggles.delete(req); resolve(r); });
        channel.postMessage({ type: 'remove_change', chatId: curState?.chatId, req, msg, id, ...(choice ? { choice } : {}) });
    });
}
async function removeFromInspector(c) {
    let r = await sendRemove(c.msg, c.id);
    if (r.confirm) r = await sendRemove(c.msg, c.id, await confirmOff(c.msg, r.confirm));
    if (!r.ok && r.error) setStatus(r.error);
    return r;
}
function sendToggle(msg, id, choice) {
    const req = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise(resolve => {
        const t = setTimeout(() => { pendingToggles.delete(req); resolve({ ok: false, error: 'No answer from SillyTavern. Is the chat open in a tab?' }); }, 15000);
        pendingToggles.set(req, r => { clearTimeout(t); pendingToggles.delete(req); resolve(r); });
        channel.postMessage({ type: 'toggle_change', chatId: curState?.chatId, req, msg, id, ...(choice ? { choice } : {}) });
    });
}
/** The small confirm before turning off a change others may need: resolves 'all', 'one' or 'cancel'. */
function confirmOff(msg, deps) {
    return new Promise(done => {
        document.querySelector('.toggle-confirm')?.remove();
        const desc = d => `#${d.msg}: ${(d.summary ?? []).join('; ') || d.note || d.id}`;
        const box = $('div', { class: 'toggle-confirm', style: 'position:fixed;z-index:1000;left:50%;top:30%;transform:translateX(-50%);max-width:30em;padding:10px 14px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor,#222);color:var(--SmartThemeBodyColor);box-shadow:0 4px 18px rgba(0,0,0,.5)' },
            $('div', {}, `Turn off the change from #${msg}?`),
            ...(deps.hard.length ? [$('div', {}, 'These later changes need it and will stop applying:'), ...deps.hard.map(d => $('div', {}, `• ${desc(d)}`))] : []),
            ...(deps.overlaps.length ? [$('div', {}, 'These touched the same places:'), ...deps.overlaps.map(d => $('div', {}, `• may depend on #${msg}: ${desc(d)}`))] : []));
        const row = $('div', { style: 'margin-top:6px' });
        for (const [label, v] of [['Turn off all', 'all'], ['Just this one', 'one'], ['Cancel', 'cancel']]) row.append($('button', { class: 'crumb', onclick: () => { box.remove(); done(v); } }, label));
        box.append(row); document.body.append(box);
    });
}
async function toggleFromInspector(c) {
    let r = await sendToggle(c.msg, c.id);
    if (r.confirm) r = await sendToggle(c.msg, c.id, await confirmOff(c.msg, r.confirm));
    if (!r.ok && r.error) setStatus(r.error);
    return r;
}
const sigOf = st => { const p = patchesOf(st); return p.length ? JSON.stringify(p.map(x => [x.id, x._msg, x.ops?.length, x.off ? 1 : 0])) + `|${st.now ?? ''}` : ''; };
async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() }, body: JSON.stringify(body) });
    if (!r.ok) { // a 400 carries {detail: {error, clash?}}: keep it for the wizards' rename prompts
        let detail = null; try { detail = (await r.json()).detail ?? null; } catch {}
        const e = new Error(typeof detail?.error === 'string' ? detail.error : `map server answered ${r.status}`); e.detail = detail; throw e;
    }
    return r.json();
}
/** "Expand with AI": the SillyTavern tab makes one model call with a prompt built here from /edit/ai-context. */
const pendingExpands = new Map();
function sendExpand(prompt) {
    const req = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pendingExpands.delete(req); reject(new Error('No answer from SillyTavern. Is the chat open in a tab?')); }, 90000);
        pendingExpands.set(req, r => { clearTimeout(t); pendingExpands.delete(req); if (r.ok) resolve(r.text); else reject(new Error(r.error ?? 'failed')); });
        channel.postMessage({ type: 'expand', chatId: curState?.chatId, req, prompt });
    });
}
async function aiText(st, { field, kind, name, area, rooms = [], text = '' }) {
    const q = st?.world ? `?world=${encodeURIComponent(st.world)}` : '';
    const c = await postJson(`${API}/edit/ai-context${q}`, { area: area ?? '', rooms, changes: st?.changes ?? [], now: st?.now ?? null });
    return sendExpand(expandPrompt(c, { field, text, name, kind }));
}
let curState = null; // the latest state message (its changes go with inspector requests)
async function worldIndex(world, version, st = curState) {
    const key = `${world}|${version}|${sigOf(st)}`;
    if (!indexCache.has(key) && patchesOf(st).length) indexCache.set(key, await postJson(`${API}/inspect/index${world ? `?world=${encodeURIComponent(world)}` : ''}`, { changes: st.changes, now: st.now ?? null }));
    if (!indexCache.has(key)) {
        const r = await fetch(`${API}/inspect/index${world ? `?world=${encodeURIComponent(world)}` : ''}`);
        if (!r.ok) throw new Error(`map server answered ${r.status}`);
        indexCache.set(key, await r.json());
    }
    return indexCache.get(key);
}
async function inspectData(world, target) {
    if (patchesOf(curState).length) return postJson(`${API}/inspect${world ? `?world=${encodeURIComponent(world)}` : ''}`, { target, changes: curState.changes, now: curState.now ?? null });
    const r = await fetch(`${API}/inspect?target=${encodeURIComponent(target)}${world ? `&world=${encodeURIComponent(world)}` : ''}`);
    if (!r.ok) throw new Error(`map server answered ${r.status}`);
    return r.json();
}
let worldsInfo = null;
async function worldInfo(world) {
    try { worldsInfo ??= await (await fetch(`${API}/worlds`)).json(); } catch { return null; }
    return worldsInfo.worlds?.find(x => x.id === (world || worldsInfo.default)) ?? null;
}
/** The state editor mode draws: every room "stood in" and every door revealed, so the whole map shows. */
export async function editorState(st) {
    const base = st?.on ? st : { type: 'state', on: true, world: '', location: null, stood: [], seen: [], doors_revealed: [], changes: [], editorOnly: true };
    const idx = await worldIndex(base.world, base.map_version ?? idx0(base));
    return { ...base, stood: [...new Set([...idx.addresses, ...(base.stood ?? [])])], seen: [], doors_revealed: [...new Set([...idx.doors, ...(base.doors_revealed ?? [])])], map_version: base.map_version ?? idx.map_version };
}
const idx0 = () => '';
const fmtVal = v => v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const fmtSecs = s => s >= 3600 ? `${+(s / 3600).toFixed(2)}h` : s >= 60 ? `${+(s / 60).toFixed(2)}m` : `${s}s`;
/** The inspector panel for one target, inside `side`. ctx: {st, room (server room dict, for rooms), exit (server exit dict), onExit(ref)}. */
async function renderInspector(side, target, ctx) {
    const st = ctx.st;
    curState = st ?? curState;
    side.replaceChildren($('p', { class: 'muted' }, 'Loading…'));
    let d;
    try { d = await inspectData(st?.world ?? '', target); } catch (e) { side.replaceChildren($('p', { class: 'empty' }, `Could not inspect: ${e.message}`)); return; }
    if (ctx.stale?.()) return;
    const changes = d.changes ?? [];
    const tabs = ['Resolved', 'Raw', 'State', `Warnings${d.warnings.length ? ` (${d.warnings.length})` : ''}`, `Changes${changes.length ? ` (${changes.length})` : ''}`];
    let tab = renderInspector.lastTab ?? 0;
    const bar = $('div', { class: 'tabs' }), pane = $('div', { class: 'tabpane' });
    const show = i => {
        tab = renderInspector.lastTab = i;
        bar.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === i));
        pane.replaceChildren(...[resolvedPane, rawPane, statePane, warnPane, changesPane][i]());
    };
    tabs.forEach((t, i) => bar.append($('button', { class: 'tab', onclick: () => show(i) }, t)));
    const resolvedPane = () => {
        const tbl = $('table', { class: 'resolved' });
        for (const r of d.resolved) tbl.append($('tr', {}, $('th', {}, r.key), $('td', {}, $('div', { class: 'val' }, r.key === 'travel_time' && typeof r.value === 'number' ? fmtSecs(r.value) : fmtVal(r.value)), $('div', { class: `src${r.source === 'from file' ? ' own' : ''}${r.changed ? ' changed' : ''}` }, ...(r.changed ? [$('span', { class: 'patchmark', title: 'changed in this chat' })] : []), r.source))));
        addColResizer(tbl);
        const out = [tbl];
        if (d.kind === 'room' && ctx.room) {
            const ul = $('ul', { class: 'exitlinks' });
            for (const e of ctx.room.exits ?? []) ul.append($('li', {}, $('button', { class: 'linkish', onclick: () => ctx.onExit(`exit:${ctx.room.address}|${e.direction.toLowerCase()}`) }, `${e.direction}${e.to_name ? ` → ${e.to_name}` : ''}`)));
            out.push($('b', {}, 'Exits (click to inspect)'), ul);
        }
        return out;
    };
    const rawPane = () => [$('pre', { class: 'raw' }, JSON.stringify(d.raw, null, 2)), ...(d.kind === 'region' || d.kind === 'subregion' ? [$('p', { class: 'muted' }, 'Child areas/rooms are collapsed to "…"; click them to see theirs.')] : [])];
    const statePane = () => {
        const rows = [['Chat', st?.editorOnly ? 'none open (showing the default world)' : st?.chatName || '—'], ['Clock', st?.clock || '—']];
        if (st?.last_wait) rows.push(['Last wait', `${st.last_wait.label} (message #${st.last_wait.msg})`]);
        if (d.kind === 'room' && ctx.room) {
            rows.push(['Party here', st?.location === ctx.room.address ? 'yes' : 'no']);
            const w = ctx.info?.weather && st?.abs_seconds !== null && st?.abs_seconds !== undefined ? placeWeather(ctx.info.weather, ctx.room.weather, st.abs_seconds, ctx.info.calendar) : null;
            const u = ctx.info?.weather?.unit ?? 'F';
            if (w) {
                rows.push(['Exposure', w.exposure]);
                if (w.outside) rows.push(['Outside', `${w.outside.label}, ${fmtTemp(w.outside.temp, u)} (feels like ${fmtTemp(w.outside.feels, u)}), ${w.outside.humidity}% humidity`]);
                if (w.inside_temp !== undefined && w.inside_temp !== null) rows.push(['Inside', fmtTemp(w.inside_temp, u)]);
                rows.push(['Narrator line', w.line]);
            } else rows.push(['Weather', st?.abs_seconds === undefined || st?.abs_seconds === null ? 'no clock yet (open a WorldScrawl chat)' : 'no weather here']);
        }
        if (d.kind === 'exit' && ctx.exit) {
            const e = ctx.exit, b = e.barrier;
            const open = (st?.doors_open ?? []).includes(e.door), shut = (st?.doors_closed ?? []).includes(e.door);
            rows.push(['Door id', e.door ?? '—']);
            if (b) rows.push(['Door now', shut ? 'closed (stamped)' : open ? 'open (stamped)' : b.starts_open ? 'open (as it starts)' : 'closed (as it starts)'], ['Locked', b.locked ? 'yes' : 'no'], ['Can be opened', b.openable ? 'yes' : 'no'], ['Stays open', b.stays_open ? 'yes' : 'no']);
            else rows.push(['Door', 'no barrier']);
            if (e.hidden || e.obscured) rows.push(['Found by this chat', (st?.doors_revealed ?? []).includes(e.door) && !st?.editorOnly ? 'yes' : 'no']);
        }
        if (changes.length) rows.push(['Changed by', changes.map(c => `${c.msg === null || c.msg === undefined ? 'a patch' : `message #${c.msg}`}${c.note ? ` (${c.note})` : ''}`).join('; ')]);
        const tbl = $('table', { class: 'resolved' });
        for (const [k, v] of rows) tbl.append($('tr', {}, $('th', {}, k), $('td', {}, v)));
        addColResizer(tbl);
        return [tbl];
    };
    const changesPane = () => changes.length ? [$('p', { class: 'muted' }, d.kind === 'world' ? 'Every map change stamped on this chat, in order. Turn one off to take it off the map for now, or delete its message to undo it.' : 'Map changes from this chat that touch this. Turn one off to take it off the map for now, or delete its message to undo it.'),
        $('ul', { class: 'warnings' }, ...changes.map(c => {
            const li = $('li', { class: `change${c.off ? ' off' : ''}${c.failed ? ' failed' : ''}`, ...(c.off ? { style: 'opacity:.6' } : {}) }, $('b', {}, c.msg === null || c.msg === undefined ? 'Patch' : `Message #${c.msg}`), `${c.note ? ` · ${c.note}` : ''}: ${(c.summary ?? []).join('; ')}${c.off ? ' (turned off)' : ''}`);
            if (Object.keys(c.relocate ?? {}).length) li.append(...renderMoves(document, moveGroups({ ops: c.ops ?? [], relocate: c.relocate, inherit: c.inherit ?? {}, names: c.names ?? {} }).groups));
            if (c.failed) li.append($('div', { class: 'cant-apply', style: 'color:#e55' }, `can't apply: ${c.failed}`));
            if (live && c.msg !== null && c.msg !== undefined && c.id) li.append(' ', $('button', { class: 'crumb togglechange', title: c.off ? 'Put this change back on the map' : 'Take this change off the map for now (it stays on its message)', onclick: () => toggleFromInspector(c) }, c.off ? 'Turn on' : 'Turn off'),
                ' ', $('button', { class: 'crumb removechange', title: 'Remove this change (it leaves its message)', onclick: () => removeFromInspector(c) }, 'Undo'));
            return li;
        }))]
        : [$('p', { class: 'muted' }, 'No map changes from this chat touch this.')];
    const warnPane = () => d.warnings.length ? [$('ul', { class: 'warnings' }, ...d.warnings.map(w => $('li', {}, w.message.replace(/^world: /, ''))))] : [$('p', { class: 'muted' }, 'No loader warnings for this.')];
    const live = !!(st?.on && st.chatId && !st.editorOnly);
    const editLabel = { room: 'Edit place', exit: 'Edit place', subregion: 'Edit subregion', region: 'Edit region' }[d.kind] ?? 'Edit';
    const editLive = $('button', { class: 'crumb editlive', title: live ? 'Change this in this chat only: SillyTavern stamps it on a hidden message (delete that message to undo). World files are never written.' : 'Open a WorldScrawl chat in SillyTavern to edit', ...(live ? {} : { disabled: '' }), onclick: async () => {
        const q = st.world ? `?world=${encodeURIComponent(st.world)}` : '';
        let ectx;
        try { ectx = await postJson(`${API}/edit/context${q}`, { target, changes: st.changes ?? [], now: st.now ?? null }); } catch (e) { pane.replaceChildren($('p', { class: 'muted' }, `Can't edit this: ${e.message}`)); return; }
        try { ectx.outline = await postJson(`${API}/edit/outline${q}`, { changes: st.changes ?? [], now: st.now ?? null }); } catch { /* plain dropdowns then */ }
        const expand = target.startsWith('exit:') ? target.split('|')[1] : null;
        const diffBox = $('div', { class: 'editlive-diff' });
        const errBox = $('ul', { class: 'pf-errors warnings' });
        let tmr = null;
        const redraw = o => { clearTimeout(tmr); tmr = setTimeout(async () => {
            if (!o.length) { diffBox.replaceChildren($('p', { class: 'muted' }, 'No changes yet.')); return; }
            try {
                const pv = await postJson(`${API}/patch/preview${q}`, { patch: { ops: withId(o) }, changes: st.changes ?? [], now: st.now ?? null });
                diffBox.style.opacity = ''; if (!moveId) errBox.replaceChildren(); diffBox.replaceChildren(renderDiff(document, pv));
            } catch (e) {
                diffBox.style.opacity = '0.5'; errBox.replaceChildren($('li', {}, e.message));
                const c = e.detail?.clash;
                if (c && c.kind === 'room') {
                    const inp = $('input', { type: 'text', class: 'mw-rename', value: moveId ?? c.suggest, oninput: () => { moveId = inp.value.trim() || c.suggest; redraw(form.getOps()); } });
                    moveId ??= c.suggest; errBox.append($('li', { class: 'mw-clash' }, `A place with id "${c.id}" is already there. Move it in as: `, inp));
                    redraw(form.getOps());
                }
            }
        }, 350); };
        let moveId = null; // a clashing Move gets a rename box prefilled with the suggested id
        const withId = o => o.map(x => (x.op === 'move_location' && moveId ? { ...x, id: moveId } : x));
        const ai = ({ kind, field, text, exit }) => aiText(st, { field, kind, text, name: ectx.title, area: ectx.area ?? target, rooms: exit ? [exit.to] : (ectx.exits ?? []).map(x => x.to).filter(Boolean) });
        const form = buildEditForm(document, ectx, { onChange: o => redraw(o), expand, ai });
        const status = $('p', { class: 'muted' }, 'Submitted changes go on a hidden message in the chat: delete it there to undo.');
        const save = $('button', { class: 'crumb pf-submit', onclick: async () => {
            const probs = form.problems(), o = withId(form.getOps());
            if (probs.length) { errBox.replaceChildren(...probs.map(p => $('li', {}, p))); return; }
            if (!o.length) { errBox.replaceChildren($('li', {}, 'Nothing changed.')); return; }
            save.disabled = true; status.textContent = 'Saving…';
            const r = await sendLiveEdit(o);
            save.disabled = false;
            if (!r.ok) { errBox.replaceChildren(...(r.errors ?? []).map(e => $('li', {}, e.error))); status.textContent = 'Not saved.'; return; }
            status.textContent = `Saved as message #${r.msg}: ${(r.summary ?? []).join('; ')}`;
        } }, 'Submit');
        redraw([]);
        pane.replaceChildren($('div', { class: 'editlive-pane' }, $('h4', {}, `${editLabel}: ${ectx.title}`), form.el, errBox, $('b', {}, 'Changes'), diffBox, save, $('button', { class: 'crumb', onclick: () => show(tab) }, 'Cancel'), status));
    } }, editLabel);
    // Create / Move / Delete wizards for this level (they stamp changes like Edit; delete the message to undo).
    const now = () => (state?.chatId && state.chatId === st?.chatId ? state : st); // the latest changes (a wizard may stamp several)
    const wq = () => (now()?.world ? `?world=${encodeURIComponent(now().world)}` : '');
    const io = {
        outline: () => postJson(`${API}/edit/outline${wq()}`, { changes: now()?.changes ?? [], now: now()?.now ?? null }),
        preview: ops => postJson(`${API}/patch/preview${wq()}`, { patch: { ops }, changes: now()?.changes ?? [], now: now()?.now ?? null }),
        submit: ops => sendLiveEdit(ops), aiText: spec => aiText(now(), spec), renderDiff, back: () => show(tab),
    };
    const actionBtns = actionsFor(d.kind).map(([a, label]) => $('button', { class: 'crumb mapact', 'data-action': a, ...(live ? {} : { disabled: '' }), title: live ? label : 'Open a WorldScrawl chat in SillyTavern to change the map', onclick: async () => {
        let outline; try { outline = await io.outline(); } catch (e) { pane.replaceChildren($('p', { class: 'muted' }, `Can't load the map outline: ${e.message}`)); return; }
        bar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        openAction(document, pane, a, { target: d.kind === 'world' ? '' : String(target).replace(/^region:/, '').replace(/^sub:/, ''), kind: d.kind, outline }, io);
    } }, label));
    side.replaceChildren($('h3', {}, d.title), $('div', { class: 'area' }, `${d.kind} · ${changes.length ? 'live (with this chat\'s changes)' : 'as in the file'} `, ...(d.kind === 'world' ? [] : [editLive]), ...actionBtns), bar, pane);
    show(Math.min(tab, tabs.length - 1));
}

// ---- Room data, fetched in batches through the plugin API and remembered per world + map version.
const roomCache = new Map(); // world -> Map(address -> room)
const revealCache = new Map(); // world -> Map(door -> [reveal])
const worldStart = new Map(); // world -> start address (the world layer's layout root)
async function fetchRooms(world, addresses, st = null) {
    const sig = sigOf(st), ckey = `${world}|${sig}`;
    if (!roomCache.has(ckey)) roomCache.set(ckey, new Map());
    const cache = roomCache.get(ckey), missing = [...new Set(addresses)].filter(a => a && !cache.has(a));
    for (let i = 0; i < missing.length; i += 40) {
        const part = missing.slice(i, i + 40);
        let b;
        if (sig) b = await postJson(`${API}/rooms${world ? `?world=${encodeURIComponent(world)}` : ''}`, { addresses: part, changes: st.changes, now: st.now ?? null });
        else {
            const r = await fetch(`${API}/rooms?addresses=${encodeURIComponent(part.join(','))}${world ? `&world=${encodeURIComponent(world)}` : ''}`);
            if (!r.ok) throw new Error(`map server answered ${r.status}`);
            b = await r.json();
        }
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
    curState = st;
    const raw = new Map(await fetchRooms(st.world, [...st.stood, ...st.seen, st.location, ...dugTo], st));
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
// ---- Draggable partitions (sizes persist in localStorage; double-click resets).
const SIZE_KEY = 'worldscrawl_sizes';
const sizes = (() => { try { return JSON.parse(localStorage.getItem(SIZE_KEY) ?? '{}') ?? {}; } catch { return {}; } })();
const saveSizes = () => { try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch {} };
const portrait = () => matchMedia('(orientation: portrait)').matches;
const sideKey = () => `side:${portrait() ? 'p' : 'l'}${document.body.classList.contains('editor') ? ':ed' : ''}`;
function applySide(side) { const v = sizes[sideKey()]; side.style.flexBasis = v ? `${v}px` : ''; side.classList.toggle('sized', !!v); }
function dragger(el, onMove, onEnd) {
    el.addEventListener('pointerdown', ev => {
        ev.preventDefault(); ev.stopPropagation(); el.setPointerCapture(ev.pointerId); el.classList.add('active');
        const move = e => onMove(e), up = () => { el.classList.remove('active'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); onEnd(); };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
}
function makeSplitter(side) {
    const sp = $('div', { class: 'splitter', title: 'Drag to resize, double-click to reset' });
    dragger(sp, e => {
        const body = side.parentElement.getBoundingClientRect(), p = portrait();
        const total = p ? body.height : body.width, raw = p ? body.bottom - e.clientY : body.right - e.clientX;
        const v = Math.round(Math.max(160, Math.min(total - 120, raw)));
        sizes[sideKey()] = v; applySide(side);
    }, saveSizes);
    sp.addEventListener('dblclick', () => { delete sizes[sideKey()]; saveSizes(); applySide(side); });
    applySide(side);
    new MutationObserver(() => applySide(side)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    matchMedia('(orientation: portrait)').addEventListener('change', () => applySide(side));
    return sp;
}
function addColResizer(tbl) {
    const apply = () => tbl.style.setProperty('--ws-keycol', sizes.keycol ? `${sizes.keycol}px` : '');
    apply();
    const first = tbl.querySelector('th'); if (!first) return;
    const h = $('span', { class: 'colresize', title: 'Drag to resize, double-click to reset' });
    first.append(h);
    dragger(h, e => { const r = tbl.getBoundingClientRect(); sizes.keycol = Math.round(Math.max(50, Math.min(r.width - 80, e.clientX - r.left))); for (const t of document.querySelectorAll('table.resolved')) t.style.setProperty('--ws-keycol', `${sizes.keycol}px`); }, saveSizes);
    h.addEventListener('dblclick', () => { delete sizes.keycol; saveSizes(); for (const t of document.querySelectorAll('table.resolved')) t.style.removeProperty('--ws-keycol'); });
}

function createMapWindow(win) {
    const body = $('div', { class: 'wsbody' }), view = $('div', { class: 'mapview' }), side = $('aside', { class: 'side' });
    win.append(body); body.append(view, makeSplitter(side), side);
    const svg = S('svg'), world = S('g');
    svg.append(world);
    const legend = $('div', { class: 'legend' });
    const centreOnPlayer = () => { if (current) setLayer(layerOf(current.full, current.here)); };
    view.append(svg, legend);
    let pick = null; // map pick mode: {spec, resolve, saved (the suspended side pane), layer, banner}
    let crumbPick = null, tf = { x: 0, y: 0, k: 1 }, current = null, selected = null, lastHere = null, lastKey = null, layer = null;
    const crumbs = document.getElementById('breadcrumb');
    const apply = () => world.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
    function centreOn(id) {
        const p = current?.pos.get(id);
        if (!p) return;
        const r = view.getBoundingClientRect();
        tf.x = r.width / 2 - p.x * tf.k; tf.y = r.height / 2 - p.y * tf.k; apply();
    }
    const layerTarget = l => l?.level === 'region' ? `region:${l.region}` : l?.level === 'subregion' ? `sub:${l.region}:${l.subregion}` : 'world';
    /** A breadcrumb: show the level holding that entity's contents and select the entity itself (not the player's child of it). */
    function pickCrumb(c) { crumbPick = { target: layerTarget(c.layer), label: c.label, level: c.layer.level }; setLayer(c.layer); }
    function showCrumbEntity(p) {
        selected = null; world.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
        if (editor) return inspectTarget(p.target);
        side.replaceChildren($('h3', {}, p.label), $('div', { class: 'area' }, p.level === 'world' ? 'World' : p.level === 'region' ? 'Region' : 'Area'), $('p', { class: 'muted' }, 'Click a place on the map to see its details.'));
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

    // ---- Pick mode: a form's "Choose…" (picker.mjs) suspends the form and picks a place / subregion / region here.
    const entityOf = n => (n.layer ? (n.layer.level === 'region' ? n.layer.region : `${n.layer.region}:${n.layer.subregion}`) : n.kind === 'stub' ? null : n.id);
    const kindOf = n => (n.layer ? n.layer.level : n.kind === 'stub' ? null : 'room');
    const PICK_LEVEL = { room: 'subregion', subregion: 'region', region: 'world' };
    const NOUN = { room: 'place', subregion: 'subregion', region: 'region' };
    /** The layer showing an entity of a kind (a place's subregion, a subregion's region, the world for a region). */
    const layerFor = (kind, id) => {
        if (!id) return null;
        if (kind === 'region') return { level: 'world' };
        const [rid, rest = ''] = String(id).split(':'), sid = rest.split('/')[0];
        if (kind === 'subregion') return rid ? { level: 'region', region: rid } : null;
        return rid && sid ? { level: 'subregion', region: rid, subregion: sid } : null;
    };
    function finishPick(v) {
        const p = pick; if (!p) return;
        pick = null;
        p.banner.remove(); win.querySelector('.wspick-confirm')?.remove();
        document.removeEventListener('keydown', p.onKey);
        side.replaceChildren(...p.saved); // the form, untouched
        layer = p.layer; lastKey = p.lastKey;
        p.resolve(v ?? null);
        update(state);
    }
    function confirmPick(id) {
        const p = pick; if (!p || !pickValid(p.spec, id)) return;
        win.querySelector('.wspick-confirm')?.remove();
        const name = pathOf(p.spec.outline, p.spec.kind, id) ?? id;
        const box = $('div', { class: 'wspick-confirm', role: 'dialog' }, $('div', { class: 'wspick-q' }, `Choose ${name}?`),
            $('button', { class: 'crumb wspick-yes', onclick: () => finishPick(id) }, 'Yes'),
            $('button', { class: 'crumb wspick-no', onclick: () => box.remove() }, 'No'));
        win.append(box); box.querySelector('.wspick-yes').focus();
    }
    function jumpTo(kind, id) {
        const l = layerFor(kind, id); if (!l || !current) return;
        layer = l; selected = null; render(current.full, current.here, current.world);
        const n = current.graph.nodes.find(x => entityOf(x) === id && kindOf(x) === kind);
        if (n) { centreOn(n.id); world.querySelectorAll('.node').forEach(g => g.classList.toggle('selected', g.dataset.id === n.id)); pickSide(n); }
        else if (pick && pickValid(pick.spec, id)) confirmPick(id); // not on the map (an empty subregion): ask right away
    }
    function pickSide(n) {
        const p = pick; if (!p) return;
        const noun = NOUN[p.spec.kind];
        side.replaceChildren($('h3', {}, `Pick the ${p.spec.title ?? noun}`),
            $('p', { class: 'muted' }, `Double-click a highlighted ${noun} to choose it. Double-click an area to open it.`));
        if (!n) return;
        const id = entityOf(n), ok = kindOf(n) === p.spec.kind && pickValid(p.spec, id);
        side.append($('b', {}, pathOf(p.spec.outline, kindOf(n), id) ?? n.name),
            ok ? $('div', {}, $('button', { class: 'crumb wspick-this', onclick: () => confirmPick(id) }, `Choose this ${noun}`))
                : $('p', { class: 'muted' }, kindOf(n) !== p.spec.kind ? `Not a ${noun}${n.layer ? ': double-click to open it' : ''}.` : (p.spec.exclude ?? []).includes(id) ? "That's the one being edited." : "Can't be chosen here."));
    }
    globalThis.wsPick = spec => new Promise(resolve => {
        if (pick) finishPick(null);
        const noun = NOUN[spec.kind] ?? spec.kind;
        const q = $('input', { type: 'search', class: 'wspick-search', placeholder: `Search ${noun}s…`, autocomplete: 'off' });
        const results = $('ul', { class: 'wspick-results' });
        q.addEventListener('input', () => results.replaceChildren(...pickSearch(spec, q.value, 12).map(r => $('li', { class: r.valid ? 'ok' : 'dim', 'data-id': r.id, onclick: () => { results.replaceChildren(); jumpTo(spec.kind, r.id); } }, r.path))));
        const banner = $('div', { class: 'wspick-banner' }, $('span', { class: 'wspick-title' }, `Picking ${spec.title ?? noun}…`),
            $('span', { class: 'wspick-find' }, q, results), $('button', { class: 'crumb wspick-cancel', onclick: () => finishPick(null) }, 'Cancel'));
        const onKey = ev => { if (ev.key === 'Escape') { if (win.querySelector('.wspick-confirm')) win.querySelector('.wspick-confirm').remove(); else finishPick(null); } };
        pick = { spec, resolve, saved: [...side.childNodes], layer, lastKey, banner, onKey };
        document.addEventListener('keydown', onKey);
        win.insertBefore(banner, body);
        side.replaceChildren();
        // Open at the field's value, else where the party is; the full map (no fog) loads in update().
        const here = current?.here ?? state?.location;
        const at = spec.value ? layerFor(spec.kind, spec.value) : here ? layerFor(spec.kind, spec.kind === 'region' ? here.split(':')[0] : spec.kind === 'subregion' ? here.split('/')[0] : here) : null;
        pick.open = { layer: at ?? { level: 'world' }, focus: spec.value || null };
        update(state);
    });
    globalThis.wsPicking = () => (pick ? { kind: pick.spec.kind, title: pick.spec.title, layer: layerKey(layer) } : null); // for the e2e tests

    let inspectSeq = 0;
    globalThis.wsInspect = (t, c) => inspectTarget(t, c); // for the e2e tests and the console
    async function inspectTarget(target, ctx = {}) {
        const seq = ++inspectSeq, st = current?.st ?? state;
        const info = await worldInfo(st?.world ?? '');
        renderInspector(side, target, { st, info, stale: () => seq !== inspectSeq, onExit: ref => inspectExit(ref), ...ctx });
    }
    function inspectExit(ref) {
        const [addr, dir] = [ref.slice(5, ref.lastIndexOf('|')), ref.slice(ref.lastIndexOf('|') + 1)];
        const room = roomCache.get(`${current?.st?.world ?? state?.world ?? ''}|${sigOf(current?.st ?? state)}`)?.get(addr);
        const exit = room?.exits?.find(e => e.direction.toLowerCase() === dir) ?? null;
        inspectTarget(ref, { exit });
    }
    function inspectNode(n) {
        if (!n) return inspectTarget('world');
        if (n.kind === 'stub') return inspectExit(`exit:${n.id.slice(5)}`);
        if (n.layer) return inspectTarget(n.layer.level === 'region' ? `region:${n.layer.region}` : `sub:${n.layer.region}:${n.layer.subregion}`);
        inspectTarget(n.id, { room: roomCache.get(`${current?.st?.world ?? ''}|${sigOf(current?.st)}`)?.get(n.id) });
    }
    function showSide(id) {
        selected = id;
        if (editor) { world.querySelectorAll('.node').forEach(n => n.classList.toggle('selected', n.dataset.id === id)); return inspectNode(current?.graph.nodes.find(x => x.id === id)); }
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
                ul.append($('li', {}, `${e.direction}${t && t.kind !== 'stub' ? ` → ${t.name}` : ''}${e.blocked ? ' (blocked)' : e.locked ? ' (locked)' : e.closed ? ' (closed door)' : ''}${e.dug ? ' (dug)' : ''}`));
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
        current = { graph, pos, here, full, world: worldId, st: current?.st ?? state };
        crumbs.replaceChildren(...breadcrumb(full, layer).flatMap((c, i, all) => [i ? $('span', { class: 'sep' }, '›') : '',
            $('button', { class: `crumb${i === all.length - 1 ? ' active' : ''}`, 'data-level': c.layer.level, 'data-target': layerTarget(c.layer), title: `Show ${c.label} and select it`, onclick: () => pickCrumb(c) }, c.label)]),
            $('button', { class: 'centerbtn', title: 'Center the map on where you are', onclick: centreOnPlayer }, $('span', { class: 'icon', 'aria-hidden': 'true' }, '⌖'), ' Center'));
        world.replaceChildren();
        const at = id => pos.get(id);
        const subs = new Map();
        for (const e of graph.edges) {
            const a = at(e.from), b = at(e.to), g = S('g', { class: `edge${e.blocked || e.back?.blocked ? ' blocked' : e.closed || e.back?.closed ? ' closed' : ''}` });
            if (!a || !b) continue;
            g.addEventListener('click', ev => { if (!editor || moved || e.direction.includes(",")) return; ev.stopPropagation(); inspectExit(`exit:${e.from}|${e.direction.toLowerCase()}`); });
            g.append(S('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
            const label = (t, f) => { if (!t) return; const el = S('text', { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - 4, 'text-anchor': 'middle' }); el.textContent = t; g.append(el); };
            label(e.direction, 0.3); if (e.back) label(e.back.direction, 0.7);
            world.append(g);
        }
        const touched = patchedRooms(current.st ?? state);
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
            const layerKey = n.layer ? `area:${n.layer.level === 'region' ? n.layer.region : `${n.layer.region}:${n.layer.subregion}`}` : null;
            if (touched.has(n.id) || (n.layer && (touched.has(layerKey) || (n.rooms ?? []).some(r => touched.has(r.address ?? r))))) {
                g.classList.add('patched');
                g.append(S('circle', { class: 'patchdot', cx: w / 2 - 7, cy: -h / 2 + 7, r: 4, fill: '#f0a030', stroke: '#222' }));
                title.textContent += ' · changed in this chat';
            }
            const ent = entityOf(n), pk = pick && kindOf(n) === pick.spec.kind ? (pickValid(pick.spec, ent) ? 'pickable' : 'pickdim') : null;
            if (pk) g.classList.add(pk);
            g.addEventListener('click', () => { if (moved) return; if (pick) { world.querySelectorAll('.node').forEach(x => x.classList.toggle('selected', x === g)); return pickSide(n); } showSide(n.id); });
            g.addEventListener('dblclick', ev => {
                ev.stopPropagation();
                // In pick mode, at the field's level: a highlighted target asks "Choose …?"; above it, areas open as usual.
                if (pick && pk === 'pickable' && layer?.level === PICK_LEVEL[pick.spec.kind]) return confirmPick(ent);
                if (n.layer) setLayer(n.layer);
            });
            world.append(g);
        }
        legend.replaceChildren(...[...subs.values()].map(s => $('span', {}, $('i', { style: `background:hsl(${s.hue} 55% 45%)` }), s.name)),
            $('span', {}, '▭ been · ⋯ seen · ┄ closed door · ✕ blocked'));
        const hereNode = graph.nodes.find(n => n.here)?.id;
        if (pick) { svg.classList.add('picking'); if (!side.childNodes.length) pickSide(null); return; }
        svg.classList.remove('picking');
        // A map wizard in progress keeps the side pane (its own stamps re-render the map; the wizard re-reads the outline).
        if (side.querySelector('.mapaction')) world.querySelectorAll('.node').forEach(n => n.classList.toggle('selected', n.dataset.id === selected));
        else if (crumbPick) { const p = crumbPick; crumbPick = null; showCrumbEntity(p); }
        else showSide(graph.nodes.some(n => n.id === selected) ? selected : hereNode);
    }

    async function update(st0) {
        let st = st0;
        if (editor || pick) { try { st = await editorState(st0); } catch (e) { side.replaceChildren($('p', { class: 'empty' }, `Could not load the world: ${e.message}`)); return; } if (st0 !== state) return; }
        if (!st || !st.on) { world.replaceChildren(); legend.replaceChildren(); crumbs.replaceChildren(); current = null; layer = null; side.replaceChildren($('p', { class: 'empty' }, NO_CHAT)); lastHere = null; return; }
        let rooms;
        try { rooms = await knownRooms(st); } catch (e) { side.replaceChildren($('p', { class: 'empty' }, `Could not load the map: ${e.message}`)); return; }
        if (st0 !== state) return; // a newer state arrived meanwhile
        if (current) current.st = st; else current = { st };
        const graph = buildGraph({ ...st, start: worldStart.get(st.world) ?? st.start }, rooms);
        const key = `${editor ? 'E' : ''}${pick ? 'P' : ''}${st.chatId}|${st.location}`, moved_ = key !== lastKey;
        if (pick?.open) { // entering pick mode
            const o = pick.open; pick.open = null; layer = o.layer; current.st = st; lastKey = key;
            render(graph, st.location, st.world);
            const n = o.focus && current.graph.nodes.find(x => entityOf(x) === o.focus);
            centreOn(n?.id ?? current.graph.nodes.find(x => x.here)?.id ?? current.graph.nodes[0]?.id);
            if (n) { world.querySelectorAll('.node').forEach(g => g.classList.toggle('selected', g.dataset.id === n.id)); pickSide(n); }
            return;
        }
        if (moved_) layer = layerOf(graph, st.location); // follow the party: open the layer with the current room
        current.st = st;
        render(graph, st.location, st.world);
        if (moved_) { centreOn(current.graph.nodes.find(n => n.here)?.id); lastKey = key; } // auto-centre when the location (or chat) changes
        lastHere = st.location;
    }
    const fn = st => update(st);
    listeners.add(fn);
    if (state || editor) update(state); else side.replaceChildren($('p', { class: 'empty' }, 'Waiting for SillyTavern…'));
    return { update };
}

// ---- Live sync.
function onState(st) {
    state = st;
    if (st.theme) applyTheme(st.theme);
    const wp = document.getElementById('waitPick'); if (wp) wp.disabled = !st.on;
    setStatus(st.on ? `${st.worldName ?? st.world ?? ''}${st.chatName ? ` · ${st.chatName}` : ''}${st.clock ? ` · ${st.clock}` : ''}${st.last_wait?.recent ? ` (${st.last_wait.label})` : ''}${st.weather ? ` · ${st.weather}` : ''}` : 'No WorldScrawl chat');
    for (const fn of listeners) fn(st);
}
channel.addEventListener('message', ev => { if (ev.data?.type === 'state') onState(ev.data); if (ev.data?.type === 'patch_result') pendingEdits.get(ev.data.req)?.(ev.data); if (ev.data?.type === 'toggle_result' || ev.data?.type === 'remove_result') pendingToggles.get(ev.data.req)?.(ev.data); if (ev.data?.type === 'expand_result') pendingExpands.get(ev.data.req)?.(ev.data); });

buildTopBar();
setEditor(editor);
toggleWindow(WINDOWS[0], true);
themeFromSettings();
channel.postMessage({ type: 'hello' });
setTimeout(() => { if (!state) { setStatus('SillyTavern not connected'); onState({ type: 'state', on: false }); state = null; } }, 2000);
