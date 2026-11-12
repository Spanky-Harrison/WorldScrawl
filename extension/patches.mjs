// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { render as P, patches as patchShared } from './shared.mjs';
import { carrierLine, clip, isCarrier, patchLib, proactiveDiscovery, snapCarriers } from './carriers.mjs';
import { chatChanges, chatElapsed } from './clock.mjs';
import { targetKeyOf } from './arearewrite.mjs';
import { expiryKey, expiryWindow, noticedExpiries } from './npcexpiry.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { api } from './doors.mjs';
import { exitsCache, renderAllExits } from './footer.mjs';
import { PATCH_KEY, baseUrl, broadcastMapState, ctx, isOn, mapVersion } from './index.js';
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
    const s = JSON.stringify(ps.map(p => [p.id, p._msg, p.ops.length, ...(p._rebuilt ?? [])])); // a rebuilt text (placerevert.mjs) is a new room text
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
async function saveKeptEdit(id, pid, form, { note, still } = {}) {
    const r = await restampChange(id, pid, form.getOps(), { note, still });
    if (r.stale) { renderPatchCards(); return r; }
    if (!r.ok) { form.setErrors(r.errors); return r; }
    openForms.delete(`${id}|${pid}`);
    renderPatchCards();
    return r;
}
/** {ok, summary} or {ok:false, errors} ({stale} when `still()` failed after the preview): the kept card's Approve edited. */
export async function restampChange(id, pid, ops, { note, still } = {}) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], p = (msg?.extra?.[PATCH_KEY] ?? []).find(x => x.id === pid);
    if (!p) return { ok: false, errors: [{ i: null, error: 'That change is no longer on its message.' }] };
    if (!ops.length) return { ok: false, errors: [{ i: null, error: 'Nothing to keep: add a change, or press Undo to remove it.' }] };
    const before = chatChanges(chat.slice(0, id));
    const r = await previewOps(ops, { changes: before, now: chatElapsed(chat.slice(0, id + 1)) });
    if (still && !still()) return { ok: false, stale: true }; // the change moved while the preview ran: write nothing
    if (!r.ok) return { ok: false, errors: r.errors };
    const old = { ops: p.ops, summary: p.summary, relocate: p.relocate, inherit: p.inherit, names: p.names, edited: p.edited, note: p.note };
    Object.assign(p, { ops: r.preview.ops ?? ops, summary: r.preview.summary, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {}, edited: Date.now(), ...(String(note ?? '').trim() ? { note: clip(String(note).trim(), 200) } : {}) });
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
    // Turning a change off can leave a later change's text resting on it: rebuild that before the narrator reads it.
    await (await import('./placerevert.mjs')).ensurePlaceRebuilds(chat.length - 1).catch(e => console.warn('[WorldScrawl] place rebuild', e?.message || e));
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


// ---- Place expiry notices. Two kinds share one card (C.placeExpiry): the vanished temporary room the party was in
// ("the passage seals behind you", kind 'missing' + expired), and a temporary text change that ran out (kind
// PLACE_EXPIRED_KIND: smoke in a room, a scorched door), posted like a person's expiry notice, one card per change.
export const isPlaceExpiry = m => m?.extra?.worldscrawl_notice_kind === 'missing' && m.extra.worldscrawl_notice_expired === true;
export const PLACE_EXPIRED_KIND = 'place_expired';
/** Any notice that carries place expiry cards (the vanished room, or timed text changes that ran out). */
export const isPlaceExpiryNotice = m => isPlaceExpiry(m) || m?.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND;
const touches = (o, address) => o.op === 'create_place' ? `${o.area}/${o.id}` === address || address.endsWith(`/${o.id}`) : [o.loc, o.into, ...(Array.isArray(o.locs) ? o.locs : [])].includes(address);
const opWhere = o => String(o?.loc ?? o?.area ?? o?.into ?? '');
/** The change whose temporary op ran out under the party: the server resolver's pick (the latest one touching that room). */
export function expiredPatchAt(chat, id) {
    const msg = chat?.[id];
    if (!isPlaceExpiry(msg) || typeof patchShared.opActive !== 'function') return null;
    const address = String(msg.extra.worldscrawl_notice_from ?? ''), now = chatElapsed(chat.slice(0, id + 1));
    const p = chatChanges(chat.slice(0, id)).reverse().find(c => c?.type === 'patch' && c.off !== true && Array.isArray(c.ops)
        && c.ops.some(o => !patchShared.opActive(o, c, now) && touches(o, address)));
    if (!p) return null;
    const ran = p.ops.filter(o => !patchShared.opActive(o, p, now));
    const made = ran.find(o => o.op === 'create_place' && touches(o, address));
    return { patch: p, address, now, ran, name: made?.name || p.names?.[address] || p.note || address };
}
/**
 * The collapse rule's keys for a vanished room's card: `<msg>|<change id>@<end time>` of the ops that ran out under the
 * party. A timed text change of the same change ending at the same time (textExpiryKey) joins that card.
 */
export function roomExpiryKeys(chat, id) {
    const got = expiredPatchAt(chat, id);
    if (!got || typeof patchShared.expiredBetween !== 'function') return [];
    const p = got.patch;
    return [...new Set(patchShared.expiredBetween([p], -Infinity, got.now).filter(g => touches(g.op, got.address)).map(g => `${p._msg}|${p.id}@${g.ends}`))];
}
/** The same key for a timed text change item of a place expiry notice. */
export const textExpiryKey = it => `${it.msg}|${it.id}@${it.ends}`;
/**
 * Timed place text changes (an op with "lasts" that rewrites a description, area notes or an exit text) that run out
 * after game time `before` and by `after`: one item per change and end time, in the order they end:
 * [{key, ends, id, msg, ops: [op index], what, where, targets}]. A turned-off change never runs out.
 */
export function placeExpiriesBetween(chat, before, after) {
    if (typeof patchShared.expiredBetween !== 'function' || !Number.isFinite(after)) return [];
    const changes = chatChanges(chat, { raw: true }), items = new Map();
    for (const g of patchShared.expiredBetween(changes, before, after)) {
        const c = changes.find(x => x?.type === 'patch' && x.id === g.patch && x.ops?.includes(g.op));
        if (!c || c.off === true) continue;
        const target = targetKeyOf(g.op);
        if (!target) continue;
        const k = `place:${c._msg}:${c.id}@${g.ends}`;
        const it = items.get(k) ?? { key: `place:${c._msg}:${c.id}`, ends: g.ends, id: c.id, msg: c._msg, ops: [], notes: [], where: opWhere(g.op), targets: [] };
        it.ops.push(c.ops.indexOf(g.op)); it.targets.push(target);
        if (g.note && !it.notes.includes(g.note)) it.notes.push(g.note);
        items.set(k, it);
    }
    return [...items.values()].map(({ notes, ...it }) => ({ ...it, what: clip(notes.join('; ') || 'a change to this place', 160) })).sort((a, b) => a.ends - b.ends);
}
/** The chat notice line for timed place changes that ran out (never in the prompt). */
export const placeExpiryNoticeText = items => `[Engine: ${(items ?? []).map(it => `The temporary change "${it.what}" ran out.`).join(' ')}]`;
/**
 * One notice for the timed place text changes that ran out and are not announced yet, right after the latest message
 * (like postPersonExpiryNotices). Returns the notice or null.
 */
export async function postPlaceExpiryNotices() {
    const c = ctx(), chat = c.chat ?? [];
    if (!isOn() || !chat.length || typeof patchShared.expiredBetween !== 'function') return null;
    const end = chat.length - 1, seen = noticedExpiries(chat);
    const { before, after } = expiryWindow(chat, end, i => chatElapsed(chat.slice(0, i + 1)));
    const items = placeExpiriesBetween(chat.slice(0, end + 1), before, after).filter(it => !seen.has(expiryKey(it)));
    if (!items.length) return null;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: placeExpiryNoticeText(items),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: PLACE_EXPIRED_KIND, worldscrawl_notice_places: items } };
    chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    return msg;
}
/**
 * One place card on an expiry notice (`id`, the card's host): what one group of the collapse rule (C.groupExpiries)
 * covers. `items`: timed text changes from a place expiry notice (several when they wrote the same text); `rooms`: the
 * vanished-room notices of the same change that ran out at the same time (the passage sealing). With neither, the
 * vanished room at `id`. `ran` is every op that ran out (each change's once); `patch` the first change.
 */
function placeExpiryAt(chat, id, items, rooms = []) {
    items = items ?? []; rooms = rooms ?? [];
    if (!items.length && !rooms.length) return expiredPatchAt(chat, id);
    const now = chatElapsed(chat.slice(0, id + 1)), changes = chatChanges(chat.slice(0, id));
    const roomGot = rooms.map(r => expiredPatchAt(chat, r)).find(Boolean) ?? null;
    if (rooms.length && !roomGot && !items.length) return null;
    const parts = new Map(); // change -> {p, ops: Set of op indexes}
    const add = (p, idx) => {
        const k = `${p._msg}|${p.id}`, part = parts.get(k) ?? { p, ops: new Set() };
        for (const i of idx) if (p.ops?.[i]) part.ops.add(i);
        if (part.ops.size) parts.set(k, part);
    };
    if (roomGot) {
        const p = changes.find(c => c?.type === 'patch' && c.id === roomGot.patch.id && c._msg === roomGot.patch._msg) ?? roomGot.patch;
        add(p, roomGot.ran.map(o => roomGot.patch.ops.indexOf(o)).filter(i => i >= 0));
    }
    const used = [];
    for (const item of items) {
        const p = changes.find(c => c?.type === 'patch' && c.id === item.id && (item.msg == null || c._msg === item.msg));
        if (!Array.isArray(p?.ops) || !(item.ops ?? []).some(i => p.ops[i])) continue;
        add(p, item.ops ?? []); used.push(item);
    }
    if (!parts.size) return null;
    const list = [...parts.values()], ran = list.flatMap(x => [...x.ops].sort((a, b) => a - b).map(i => x.p.ops[i]));
    const first = used[0] ?? null, where = first ? first.where || opWhere(ran[0]) : roomGot.address;
    const notes = [...new Set(list.map(x => x.p.note).filter(Boolean))].join('; ');
    return { patch: list[0].p, patches: list.map(x => x.p), address: where, now, ran, name: first ? list[0].p.names?.[where] || '' : roomGot.name,
        item: first, items: used, note: notes, ...(roomGot && first ? { room: roomGot.name, roomAddress: roomGot.address } : {}) };
}
/** The ops that ran out, kept for good: what the notice's Edit starts from. */
export const keptForGood = ops => (ops ?? []).map(o => { const { lasts, ...rest } = o; return rest; });
const expiryViews = new WeakMap(); // notice message -> Map(card key -> {sig, preview, error})
/**
 * The before/now panel of a place expiry card: a preview of the chat's changes with the ran-out ops (kept for good) and
 * without them. Fetched once per card and cached (a text rebuilt since changes the key); the card redraws when it arrives.
 * `items`: the timed changes of a PLACE_EXPIRED_KIND notice one card shows (one item, or a group); none for the vanished room.
 */
export function expiryView(chat, id, items = null, rooms = null) {
    items = items == null ? [] : Array.isArray(items) ? items : [items];
    const got = placeExpiryAt(chat, id, items, rooms ?? []);
    if (!got) return null;
    const msg = chat[id], ran = new Set(got.ran), own = new Set((got.patches ?? [got.patch]).map(p => `${p._msg}|${p.id}`));
    // Now: every change before the notice, with the ops that ran out taken off their change (the rest of it stays).
    const others = chatChanges(chat.slice(0, id)).flatMap(c => {
        if (!own.has(`${c._msg}|${c.id}`)) return [c];
        const ops = (c.ops ?? []).filter(o => !ran.has(o));
        return ops.length ? [{ ...c, ops }] : [];
    });
    const sig = `${[...own].join(',')}|${got.now}|${JSON.stringify(got.ran)}|${JSON.stringify(others.map(c => c._rebuilt ?? null))}`;
    const views = expiryViews.get(msg) ?? new Map(), vk = [...(got.items ?? []).map(it => it.key), ...(rooms ?? []).map(r => `room:${r}`)].join(',');
    expiryViews.set(msg, views);
    let v = views.get(vk);
    if (!v || v.sig !== sig) {
        v = { sig, preview: null, error: '' };
        views.set(vk, v);
        previewOps(keptForGood(got.ran), { changes: others, now: got.now }).then(r => {
            if (views.get(vk) !== v) return;
            if (r.ok) v.preview = { before: r.preview.after ?? {}, after: r.preview.before ?? {}, ops: [], relocate: {}, inherit: {}, names: r.preview.names ?? {} };
            else v.error = `Could not show what changed: ${r.errors?.[0]?.error ?? 'preview failed'}`;
            renderPatchCards();
        }, e => { if (views.get(vk) === v) { v.error = `Could not show what changed: ${e?.message || e}`; renderPatchCards(); } });
    }
    return { ...got, preview: v.preview, error: v.error };
}
/**
 * Approve edited on a place expiry card: the form's ops become a new kept map change on the notice (from here on;
 * deleting the notice removes it). `still()` is the card's ticket: a notice deleted or swiped mid-save writes nothing.
 */
export async function keepExpiryEdit(id, key, note = '', still = () => true, item = null) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], form = openForms.get(key);
    if (!isPlaceExpiryNotice(msg) || !form) return { ok: false, error: 'That notice is gone.' };
    const ops = form.getOps();
    if (!ops.length) { form.setErrors([{ i: null, error: 'Nothing to keep: add a change, or press Close editor.' }]); return { ok: false }; }
    const now = chatElapsed(chat.slice(0, id + 1));
    const r = await previewOps(ops, { changes: chatChanges(chat.slice(0, id + 1)), now });
    if (!still()) { renderPatchCards(); return { ok: false, stale: true }; }
    if (!r.ok) { form.setErrors(r.errors); return { ok: false, errors: r.errors }; }
    const p = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: clip(note, 200) || clip(r.preview.summary?.[0] ?? 'map edit', 120), at: now,
        ops: r.preview.ops ?? ops, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {}, summary: r.preview.summary, range: null, swipe: swipeOf(msg), source: 'expiry_edit', ...(item?.key ? { expiry: item.key } : {}) };
    msg.extra[PATCH_KEY] = [...(msg.extra[PATCH_KEY] ?? []), p];
    syncSwipeExtra(msg);
    openForms.delete(key);
    await c.saveChat?.();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, patch: p };
}

export { FLAG_TAG, RANGE_CAP, confirmOff, drawDiff, drawPersonDiff, failedFor, liveDiff, loadFormLib, mapCtx, openEditor, openForms, patchSig, pendingFoundFlags, pendingLoreFlags, pendingNameFlags, pendingNpcFlags, refreshChangeStatus, relocateFrom, saveKeptEdit, swipeOf, toggleFromCard };
