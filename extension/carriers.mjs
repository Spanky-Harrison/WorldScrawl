// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { render as P, hasPrompts, patches } from './shared.mjs';
import { baseReply, gen, mergeDuplicates, nearbyRooms, noteCall } from './dig.mjs';
import { analyzeDiscovery, keepFlag, syncSwipeExtra } from './discovery.mjs';
import { api, currentLocation, ensurePrompts } from './doors.mjs';
import { aftermathNote, applyNudge, applyTools } from './expiry.mjs';
import { exitsCache, renderAllExits } from './footer.mjs';
import { FLAG_KEY, MOVE_KEY, PATCH_KEY, baseUrl, broadcastMapState, ctx, isOn, settings } from './index.js';
import { RANGE_CAP, changeDependents, confirmOff, loadFormLib, mapCtx, patchesOn } from './patches.mjs';
import { applyFacts } from './scene.mjs';
import { renderPatchCards } from './waits.mjs';
import { REWRITE_SET_BY_YOU, mergeRewrite, rewriteGuard, targetLines, textTargets } from './arearewrite.mjs';
 // from the ws_flag tool: attached to the reply when it arrives
let patchLib = null;

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
async function loadPatchLib() { if (patches.applyPatch) patchLib ??= patches; return patchLib; } // plugin/shared/, loaded at startup (shared.mjs)

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
function discoveryChanged() { try { if (hasPrompts() && isOn()) { applyTools(); applyNudge(); } } catch (e) { console.warn('[WorldScrawl]', e?.message); } } // a flagged player message waiting for the narrator's reply
// ---- Stale results: each analysis or rewrite of a flag takes a ticket; a newer one, a swipe, Discard or Approve makes it stale,
// and a stale one writes nothing (the flag object is replaced on a new flag, deleted on Discard, and kept on Approve).
const flagTickets = new WeakMap();
const rewriting = new WeakMap(); // flag -> { to: 'light' | 'full' } while a scope switch is asking (not saved: a reload never sticks)
export const rewritingOf = f => (f ? rewriting.get(f)?.to ?? '' : '');
function takeTicket(id) {
    const msg = ctx().chat?.[id], f = msg?.extra?.[FLAG_KEY];
    const n = (flagTickets.get(f) ?? 0) + 1;
    if (f) flagTickets.set(f, n);
    const stale = () => ctx().chat?.[id] !== msg || msg?.extra?.[FLAG_KEY] !== f || flagTickets.get(f) !== n || (f.swipe ?? 0) !== (msg.swipe_id ?? 0) || f.status === 'kept';
    return { msg, f, stale };
}
/** Check again and Rewrite with this: both steps again. `note` (from Edit's Change box) replaces the flag's note; the
 *  player's light touch / full rewrite pick and the story range are kept. */
async function analyzeFlag(id, { note } = {}) {
    const c = ctx(), chat = c.chat ?? [];
    const { msg, f, stale } = takeTicket(id);
    if (!f) return;
    if (f.kind === 'discover') return analyzeDiscovery(id);
    rewriting.delete(f);
    if (typeof note === 'string' && note.trim() && note.trim() !== f.note) { f.note = clip(note, 200); f.noteBy = 'player'; }
    if (f.start == null || f.start === '' || !Number.isFinite(Number(f.start))) f.start = suggestStart(chat, id, f.loc);
    f.status = 'working'; f.error = ''; delete f.proposal; delete f.rewriteError;
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
        if (stale()) return;
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
        const rewrite = f.rewrite === 'full' ? 'full' : 'light';
        const patchQ = (err = '') => pl.patchPrompt(c2, { story: clip(story, 6000), what, err, range: `#${f.start}-#${id}`, rewrite });
        let ops = null, err = '', preview = null, merged = [], unmerged = null;
        const nearHere = f.loc ? await nearbyRooms({ address: f.loc }).catch(() => []) : [];
        for (let tries = 0; tries < 2; tries++) {
            if (!pl) throw new Error('the map tools (patches.mjs) could not be loaded from the server');
            const ans = pl.readChangeAnswer(parseJsonAnswer(await askModel(c, 'the change', { prompt: patchQ(err), systemPrompt: patchSys(pl), responseLength: 1200 })));
            if (stale()) return;
            if (ans?.personClaims?.length && pl.personClaimWarning) f.personWarning = pl.personClaimWarning(ans.personClaims);
            else if (ans) delete f.personWarning;
            if (ans?.cant) { f.status = 'cant'; f.error = ans.cant; return; }
            if (ans?.nothing) { f.status = 'nothing'; return; }
            ops = ans?.ops ?? null;
            if (!ops) { err = 'the answer was not {"ops": [...]} JSON'; continue; }
            const md = mergeDuplicates(ops, nearHere); // a "new" room that is a place a few steps away: connect to that place instead
            if (md.merged.length) {
                const rm = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: md.ops }, ...mapCtx() }) });
                if (rm.ok) { preview = rm.body; unmerged = ops; ops = rm.body.ops ?? md.ops; merged = md.merged; break; }
            }
            const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops }, ...mapCtx() }) });
            if (r.ok) { preview = r.body; ops = r.body.ops ?? ops; break; }
            err = r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status);
        }
        if (stale()) return;
        if (!preview) {
            f.error = `The suggested change didn't fit the map: ${err}`;
            if (Array.isArray(ops) && ops.length) { f.status = 'review'; f.proposal = { ops, invalid: true, summary: [`⚠ ${f.error}`], relocate: {}, inherit: {}, names: {}, before: {}, after: {}, rewrite }; }
            else f.status = 'error';
            return;
        }
        const mergedLines = merged.map(m => `Connected to ${m.to_name} (already on the map, ${m.steps} step${m.steps === 1 ? '' : 's'} away) instead of adding a new "${m.name}".`);
        f.proposal = { ops, summary: [...preview.summary, ...mergedLines], relocate: preview.relocate, inherit: preview.inherit ?? {}, names: preview.names ?? {}, before: preview.before, after: preview.after, rewrite, ...(merged.length ? { merged, unmerged } : {}) };
        f.status = 'review';
        if (settings().autoKeep) await keepFlag(id, { quiet: true });
    } catch (e) {
        if (stale()) return;
        console.error('[WorldScrawl] map flag', e);
        f.status = 'error'; f.error = e?.message || String(e);
    } finally {
        try { await c.saveChat?.(); } catch (e) { console.error('[WorldScrawl] save', e); }
        renderPatchCards();
    }
}

export const rewriteSys = (pl, rewrite) => P('change.rewrite_system', { reply: baseReply('json'), rewrite: pl.rewritePiece(rewrite), style: P('change.style') });
export const rewritePrompt = (pl, { story, what, targets, rewrite }) => P('change.rewrite', { story, what, targets: targetLines(targets), rewrite: pl.rewritePiece(rewrite) });
/**
 * The light touch / full rewrite switch on a proposed place change: ask again for ONLY the proposal's existing texts
 * (one call listing them), keep every other edit, the rooms and the lasts, and check the result with rewriteGuard. On any
 * failure the old proposal stays and the card says why. Returns '' or the reason.
 */
async function swapRewrite(id, to) {
    const c = ctx(), chat = c.chat ?? [];
    const { msg, f, stale } = takeTicket(id);
    const pr = f?.proposal;
    if (!f || f.status !== 'review' || !pr || pr.invalid) return 'there is no proposed change to rewrite';
    to = to === 'full' ? 'full' : 'light';
    const targets = textTargets(pr);
    const fail = why => { if (stale()) return why; f.rewriteError = `Couldn't switch to ${to === 'full' ? 'a full rewrite' : 'a light touch'}: ${why}. The change is as it was.`; noteCall(id, { kind: 'map rewrite', status: 'failed', reason: why }); toastr.warning(`WorldScrawl: ${f.rewriteError}`); return why; };
    if (!targets.length) return fail('this change rewrites no existing description, notes or exit text');
    const mine = { to };
    rewriting.set(f, mine); delete f.rewriteError;
    renderPatchCards();
    try {
        await ensurePrompts();
        const pl = await loadPatchLib();
        if (!pl) throw new Error('the map tools (patches.mjs) could not be loaded from the server');
        const story = clip(storyText(chat, f.start ?? id, id), 6000);
        const what = [f.note && `The player or narrator noted: "${clip(f.note, 200)}".`, f.hint && `Place mentioned: "${clip(f.hint, 80)}".`].filter(Boolean).join(' ');
        const raw = await askModel(c, `rewrite (${to})`, { prompt: rewritePrompt(pl, { story, what, targets, rewrite: to }), systemPrompt: rewriteSys(pl, to), responseLength: 1200 });
        if (stale()) return 'stale';
        const ans = pl.readChangeAnswer(parseJsonAnswer(raw));
        if (!ans || ans.cant || !Array.isArray(ans.ops)) return fail(ans?.cant ? `the model said it can't: ${ans.cant}` : ans?.nothing ? 'the model rewrote nothing' : "the model's answer was not {\"ops\": [...]} JSON");
        const m = mergeRewrite(pr.ops, targets, ans.ops);
        if (m.error) return fail(m.error);
        const bad = rewriteGuard(pr.ops, m.ops);
        if (bad) return fail(bad);
        const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: m.ops }, ...mapCtx() }) });
        if (stale()) return 'stale';
        if (!r.ok) return fail(`the rewritten change didn't fit the map: ${r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status)}`);
        if (r.body.noops?.length) return fail(`the rewrite left ${r.body.noops.length === 1 ? 'a text' : `${r.body.noops.length} texts`} exactly as before the change`);
        const after = rewriteGuard(pr.ops, r.body.ops ?? m.ops); // the engine's own check of what the map would apply
        if (after) return fail(after);
        const keep = { merged: pr.merged, unmerged: pr.unmerged, newRoom: pr.newRoom };
        f.proposal = { ops: r.body.ops ?? m.ops, summary: [...r.body.summary, ...(pr.summary ?? []).filter(l => /^(Connected to|Added as a new room)/.test(l))], relocate: r.body.relocate ?? {}, inherit: r.body.inherit ?? {}, names: r.body.names ?? {}, before: r.body.before, after: r.body.after, rewrite: to,
            ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v != null)) };
        f.rewrite = to; f.why = REWRITE_SET_BY_YOU;
        noteCall(id, { kind: 'map rewrite', status: 'ok', reason: `${to === 'full' ? 'full rewrite' : 'light touch'} of ${m.rewritten.length} text${m.rewritten.length === 1 ? '' : 's'}` });
        return '';
    } catch (e) {
        console.error('[WorldScrawl] map rewrite', e);
        return fail(e?.message || String(e));
    } finally {
        if (rewriting.get(f) === mine) rewriting.delete(f);
        try { await c.saveChat?.(); } catch (e) { console.error('[WorldScrawl] save', e); }
        renderPatchCards();
    }
}

export { analyzeFlag, swapRewrite, askModel, carrierLine, clip, discoveryChanged, loadPatchLib, onMessagesDeleted, patchLib, removeFromCard, storyText };
