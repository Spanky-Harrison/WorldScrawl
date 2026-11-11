// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { render as P } from './shared.mjs';
import { carrierLine, clip, isCarrier, patchLib, proactiveDiscovery, snapCarriers } from './carriers.mjs';
import { chatChanges, chatElapsed, defaultWorldId } from './clock.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { api } from './doors.mjs';
import { exitsCache, renderAllExits } from './footer.mjs';
import { MAP_URL, PATCH_KEY, activeWorld, baseUrl, broadcastMapState, ctx, isOn, mapVersion } from './index.js';
import { rememberToggle } from './expiry.mjs';
import { applyFacts } from './scene.mjs';
import { cardButton, renderPatchCards } from './waits.mjs';
import { editLib } from './cardlib.mjs';

// ---- Map patches: lasting changes to places (a fire, a collapse, a smashed door). A patch is stamped on the message
// where the change settled (PATCH_KEY, per swipe); the server applies the stamped patches to the world per request
// (plugin/shared/patches.mjs), world files are never written, and deleting the message undoes the patch. Triggers: the
// flag button on a message, the ws_flag tool, a [ws_flag: place | what changed] tag in a reply, and /ws-change.
export const flagHint = (on = proactiveDiscovery()) => P('narration.flag_hint', { discover: P(on ? 'narration.discover_proactive' : 'narration.discover_strict') });
export const flagToolText = (on = proactiveDiscovery()) => P('narration.flag_tool', { discover: P(on ? 'narration.flag_tool_proactive' : 'narration.flag_tool_strict') });
export const flagActionText = (on = proactiveDiscovery()) => P('narration.flag_action', { discover: P(on ? 'narration.flag_action_proactive' : 'narration.flag_action_strict') });
export const waitHint = () => P('narration.wait_hint');
const FLAG_TAG = /\[ws_flag:\s*([^\]]{0,300})\]/i; // from ws_flag action wait/sleep: stamped on the reply when it arrives
const RANGE_CAP = 10;
let pendingFoundFlags = []; // names from ws_flag action found: judged and stamped on the reply
let pendingNameFlags = []; // names from ws_flag action name: the player learned them; stamped on the reply
let pendingNpcFlags = []; // names from ws_flag action npc: stamped on the reply when it arrives
let pendingLoreFlags = [];
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
/** A person's change in the same red/green view as a place's (see renderPersonDiff). */
/** Tests hand in the plugin's diff module (the server URL isn't reachable outside SillyTavern). */
export const useDiffLib = m => { diffLib = m; };
/** Tests hand in the plugin's patch form module the same way. */
export const useFormLib = m => { formLib = m; };
function drawPersonDiff(box, opts) {
    // Draw at once when the diff module is already loaded, so a redrawn card never flashes empty.
    if (diffLib?.renderPersonDiff) { box.replaceChildren(diffLib.renderPersonDiff(document, opts)); return Promise.resolve(); }
    return drawPersonDiffLater(box, opts);
}
async function drawPersonDiffLater(box, opts) {
    const dl = await loadDiffLib();
    if (!dl?.renderPersonDiff) { box.textContent = ''; return; }
    box.replaceChildren(dl.renderPersonDiff(document, opts));
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
    editLib()?.closeCardEditor(key); // a fresh editor: nothing typed earlier comes back
    let form = null;
    form = fl.buildPatchForm(document, { ops, rooms: ch.rooms, areas: ch.areas, names: ch.names, areaNames: ch.areaNames, context, onChange: o => { form?.onLive?.(o); } });
    form.startOps = JSON.stringify(form.getOps()); // what it opened with: a scope switch asks before dropping hand edits
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
 *  choice 'all' (also turn those off), 'one' (just this one) or 'cancel'. The on/off state the last story reply saw
 *  is stored on the patch. No chat row is added. */
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
    const touched = [[mi, pid], ...others.map(d => [d.msg, d.id])];
    for (const [i, id] of touched) {
        const q = find(i, id);
        if (!q) continue;
        rememberToggle(chat, q, i, id, q.off === true);
        if (turningOn) delete q.off; else q.off = true;
        syncSwipeExtra(chat[i]);
    }
    const also = [...new Set(others.map(d => d.msg))].filter(i => i !== mi);
    await c.saveChat?.();
    exitsCache.clear();
    await applyFacts();
    await renderAllExits();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, off: !turningOn, msgs: [mi, ...also] };
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

export { FLAG_TAG, RANGE_CAP, changeEditSession, confirmOff, drawDiff, drawPersonDiff, failedFor, liveDiff, loadFormLib, mapCtx, openEditor, openForms, patchSig, pendingFoundFlags, pendingLoreFlags, pendingNameFlags, pendingNpcFlags, refreshChangeStatus, relocateFrom, saveKeptEdit, swipeOf, toggleFromCard };
