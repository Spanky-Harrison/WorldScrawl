// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { trackMark } from './tracker.mjs';
import { waitReason } from './words.mjs';
import { DECIDED_KEY, noticeIdOf, newNoticeId, isDecided, markDecided, once } from './notices.mjs';
import { render as P, cards as C } from './shared.mjs';
import { UPDATE_LINE, cardLib, editLib } from './cardlib.mjs';
import { runCardAction, ticketFor } from './cardacts.mjs';
import { NPC_KEY, NPC_WARN_KEY, FOUND_KEY, npcAt, fileDiff, reviewSummary, stampSummary } from './npc.mjs';
import { analyzeFlag, clip, flagStatusText, isCarrier, loadPatchLib, parseJsonAnswer, rewritingOf, suggestStart } from './carriers.mjs';
import { targetLabel, textTargets } from './arearewrite.mjs';
import { calendarLib, chatChanges, chatElapsed, defaultWorldId, loadCalendar, placeWeatherNow, weatherLib, worldTimes } from './clock.mjs';
import { baseReply, gen, noteCall } from './dig.mjs';
import { discardFlag, flagMessage, markUnreadTags, syncSwipeExtra } from './discovery.mjs';
import { currentLocation, ensurePrompts, getStoredLocation } from './doors.mjs';
import { renderAllExits } from './footer.mjs';
import { FLAG_KEY, WAITCARD_KEY, WAIT_KEY, activeWorld, broadcastMapState, ctx, hooks, isOn, openCarriers, settings } from './index.js';
import { lastUserIndex, partyText } from './movement.mjs';
import { PLACE_EXPIRED_KIND, drawDiff, expiryView, failedFor, isPlaceExpiry, liveDiff, openForms, patchesOn, previewOps, refreshChangeStatus, swipeOf } from './patches.mjs';
import { APPEAR_KEY, REMEMBER_KEY, abandonStuckAppearance, appearJobs, applyFacts, castPack, exportNpc, npcBefore, npcClock, personExpiriesIn, personExpiryTurn, prefetchRemember } from './scene.mjs';
import { NPC_EXPIRED_KIND, changeLabel, modelChangeLabel } from './npcexpiry.mjs';
import { reviewFields } from './replay.mjs';
import { placeExpiryTurn } from './placerevert.mjs';
import { onWorkChange, workingOn } from './work.mjs';

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
export async function planWait(args, sleep = false, reason = '') {
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
    return { seconds, sleep, label, until: p.until ?? null, afterText, reason: waitReason(reason) };
}
/** A narrator wait under MIN_NARRATOR_WAIT: noted in the inspector's call log with its reason, then dropped. */
function noteShortWait(w) { noteCall(undefined, { kind: `narrator wait ${w.label}`, status: 'skipped', reason: `short${w.reason ? `; why: ${w.reason}` : ''}` }); }
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
/** A narrator wait waits for the player: Approve, Edit → Approve edited, or Discard on a card (unless Auto-keep waits is on). */
const waitAsk = () => (settings().autoKeepWaits ? '' : ' (The player will confirm it.)');
/** The amount as the player would type it: "until morning", "2h 30m". */
export const waitAmount = w => (w.until ? `until ${w.until}` : calendarLib?.formatDuration ? calendarLib.formatDuration(w.seconds) : `${Math.round(w.seconds / 60)}m`);
export function proposeWait(msg, w) {
    msg.extra = msg.extra ?? {};
    msg.extra[WAITCARD_KEY] = { nid: newNoticeId('wait'), swipe: swipeOf(msg), seconds: w.seconds, sleep: !!w.sleep, label: w.label, until: w.until ?? null, amount: waitAmount(w), reason: w.reason || '' };
}
/** Approve (amount unchanged) or Approve edited (a new amount) a proposed wait: the same stamp as a narrator wait kept at once. */
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
    if (w !== p) w = { ...w, reason: p.reason || '' };
    if (!markDecided(msg, nid, w === p ? 'approve' : 'adjust', { swipe: swipeOf(msg), text: `${w.label} passed${p.reason ? ` (${p.reason})` : ''}` })) return 'already decided';
    noteCall(c.chat.indexOf(msg), { kind: `narrator wait ${w.label}`, status: 'ok', reason: `kept by the player; why: ${p.reason || '(no reason given)'}` });
    stampWait(msg, w);
    if (p.source) msg.extra[WAIT_KEY].source = p.source;
    if (p.swipe != null) msg.extra[WAIT_KEY].swipe = p.swipe;
    delete msg.extra[WAITCARD_KEY];
    renderPatchCards();
    await c.saveChat?.(); { const host = c.chat.length - 1; await personExpiryTurn(host); await placeExpiryTurn(host); } await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
    return '';
}
/** Which temporary changes a re-timed wait now runs past (crossed) or no longer reaches (uncrossed), keyed by change and op. */
export function waitExpiryDelta(changes, start, oldSec, newSec, expiredBetween) {
    const key = g => `${g.id ?? ''}#${g.op ?? g.index ?? ''}#${g.note}`;
    const was = expiredBetween(changes, start, start + oldSec), now = expiredBetween(changes, start, start + newSec);
    const wk = new Set(was.map(key)), nk = new Set(now.map(key));
    return { crossed: now.filter(g => !wk.has(key(g))), uncrossed: was.filter(g => !nk.has(key(g))) };
}
/** Place patches (lib.expiredBetween) and people's temporary changes that run out between two game times, as one list. */
export function expiredAll(chat, lib, party = partyText()) {
    return (changes, before, after) => [
        ...(lib?.expiredBetween ? lib.expiredBetween(changes, before, after) : []),
        ...personExpiriesIn(chat, before, after, party).map(it => ({ id: it.key, op: 'person', note: changeLabel(it), ends: it.ends, person: it })),
    ].sort((a, b) => a.ends - b.ends);
}
/** Re-time an already-kept wait. The clock moves, so expiries are rechecked: the map is rebuilt from the chat (the server keeps no state). */
export async function editKeptWait(id, amount) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], old = msg?.extra?.[WAIT_KEY];
    if (!old) return { error: 'no kept wait on that message' };
    const w = await planWait(String(amount), old.sleep);
    if (w.error) return { error: w.error };
    const lib = await loadPatchLib();
    const start = chatElapsed(chat.slice(0, id + 1)) - old.seconds;
    const delta = waitExpiryDelta(chatChanges(chat), start, old.seconds, w.seconds, expiredAll(chat, lib));
    stampWait(msg, w);
    await c.saveChat?.(); if (delta.crossed.length) { const host = chat.length - 1; await personExpiryTurn(host); await placeExpiryTurn(host); } await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
    if (delta.crossed.length) toastr.info(`WorldScrawl: now runs out during the wait: ${delta.crossed.map(g => g.note).join('; ')}`);
    if (delta.uncrossed.length) toastr.info(`WorldScrawl: still in place after the shorter wait: ${delta.uncrossed.map(g => g.note).join('; ')}`);
    return delta;
}
export async function discardWait(id) {
    const c = ctx(), msg = c.chat?.[id], p = msg?.extra?.[WAITCARD_KEY];
    if (!p) return;
    if (!markDecided(msg, noticeIdOf(p, 'wait'), 'discard', { swipe: swipeOf(msg), text: `no time passes (${p.label}${p.reason ? `: ${p.reason}` : ''})` })) return;
    noteCall(id, { kind: `narrator wait ${p.label}`, status: 'skipped', reason: `discarded by the player; why: ${p.reason || '(no reason given)'}` });
    delete msg.extra[WAITCARD_KEY];
    renderPatchCards(); await c.saveChat?.();
}
function stampWait(msg, w) {
    msg.extra = msg.extra ?? {};
    msg.extra[WAIT_KEY] = { seconds: w.seconds, sleep: !!w.sleep, label: w.label, ...(w.until ? { until: w.until } : {}), ...(w.reason ? { reason: w.reason } : {}) };
}
/** The auto-sent wait message: "*Knarfy waits for 2h.*", "*Knarfy sleeps for 8h, until morning.*" */
export function waitNote(who, w) {
    const dur = calendarLib?.formatDuration ? calendarLib.formatDuration(w.seconds) : `${w.seconds}s`;
    return `*${who} ${w.sleep ? 'sleeps' : 'waits'} for ${dur}${w.until ? `, until ${w.until}` : ''}.*`;
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
    const gone = expiredAll(chat, lib, who)(chatChanges(chat), before, after);
    if (gone.length) lines.push(`While ${who} ${r.w.sleep ? 'slept' : 'waited'}, these temporary changes ran out and are gone now: ${gone.map(g => (g.person ? modelChangeLabel(g.person) : g.note)).join('; ')}.${gone.some(g => g.person) ? ' Describe the people as they are now (see the people listed).' : ''}`);
    return lines.join('\n');
}

// A call starting or ending redraws the cards (work.mjs), so a rebuild is never silent.
onWorkChange(() => { if (typeof document !== 'undefined') renderPatchCards(); });

/** The descriptor adapters this extension draws with: an older plugin without one of them shows the update line. */
const CARD_ADAPTERS = ['placeReview', 'personReview', 'personKept', 'personExpiry', 'placeExpiry', 'rememberReview', 'placeKept', 'personNote', 'foundKept', 'placeStatus', 'waitReview', 'appearJob', 'resolvedNote', 'warnNote'];
/** A notice button (the shared card button): decides locks the row on the first click and redraws the cards after. */
const cardHooks = { onError: err => { console.error('[WorldScrawl] notice', err); toastr.error(`WorldScrawl: ${err?.message || err}`); }, after: () => renderPatchCards() };
function cardButton(label, onClick, title = '', decides = false) { return cardLib().cardButton(document, label, onClick, title, decides, cardHooks); }
const markPending = el => cardLib().markPending(el);
/** Draw a shared card; its clicks go through the action layer with the ticket taken now. */
function drawCard(desc, type, ticket) { return cardLib().renderCard(document, desc, (id, a) => runCardAction(type, id, ticket, a), cardHooks); }
/** Notice text, then ONE right-aligned button row at the end. */
const rowOf = (...buttons) => cardLib().noticeRow(document, buttons.flat().filter(Boolean));
const fieldsOf = (...els) => { const f = document.createElement('div'); f.className = 'worldscrawl_notice_fields'; f.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;'; f.append(...els.filter(Boolean)); return f; };
/** The review card for a person's appearance change: the shared card (summary list, red/green panel, one row). */
function personCardEl(msg, s, who) {
    const key = `${s.identity?.owner}|npcedit`;
    // Its own call running now (a Check again on a failed one too): the card says it is working, never silent.
    const asking = workingOn(msg).some(j => j.owner && j.owner === s.identity?.owner);
    const failedJob = !asking && s.candidate?.phase === 'failed' ? appearJobs(msg).find(j => j.owner && j.owner === s.identity?.owner && j.status === 'failed') : null;
    const c = s.candidate, phase = asking ? 'working' : c?.phase || 'working';
    const rows = phase === 'review' && c.lastingPreview && c.livePreview ? reviewFields(c) : [];
    const scoped = !!c && c.kind !== 'baseline' && s.kind !== 'baseline';
    const editing = !!editLib()?.editorOpen(key);
    // The editor edits exactly the panel's changed rows (a body-only change edits only Body); Approve edited keeps this text.
    const fields = editing && phase === 'review' ? rows.map(r => ({ key: `${r.part}.${r.field}`, label: r.label, value: (r.part === 'live' ? c.livePreview : c.lastingPreview)?.[r.field] ?? '', cls: 'worldscrawl_npc_text', data: { part: r.part, field: r.field } })) : [];
    const desc = C.personReview({ key, who, phase, summary: phase === 'review' ? reviewSummary(c, who, rows) : [], panelRows: phase === 'review' ? reviewFields(c, { all: true }) : [],
        scoped, heavy: scoped && c.scope === 'heavy', why: c?.why ?? '', clockError: c?.clockError ?? '', failReason: failedJob?.reason ?? '', editing, intent: c?.intent ?? '', fields });
    return drawCard(desc, 'person', ticketFor('person', { msg, s, who }));
}

/** "Show change" under a kept map change: collapsed; opening it fetches the change's before/after once and draws it. */
const openShows = new WeakSet();
function showChangeEl(id, p) {
    const ch = ctx().chat ?? [];
    const det = document.createElement('details'); det.className = 'worldscrawl_change_show';
    const sum = document.createElement('summary'); sum.textContent = 'Show change'; det.append(sum);
    const box = document.createElement('div'); box.className = 'worldscrawl_diff'; det.append(box);
    const load = () => previewOps(p.ops, { changes: chatChanges(ch.slice(0, id)), now: chatElapsed(ch.slice(0, id + 1)) })
        .then(r => (r.ok ? drawDiff(box, r.preview) : (box.textContent = `Could not show this change: ${r.errors?.[0]?.error ?? 'preview failed'}`)), e => { box.textContent = `Could not show this change: ${e?.message || e}`; });
    if (openShows.has(p)) { det.open = true; load(); }
    det.addEventListener('toggle', () => { if (det.open) { openShows.add(p); if (!box.childNodes.length) load(); } else openShows.delete(p); });
    return det;
}
/** A kept (or turned off) map change: the shared card; Edit opens the same map form + Change: as the review card. */
function placeKeptEl(msg, id, p) {
    const ch = ctx().chat ?? [];
    const key = `${id}|${p.id}`, form = openForms.get(key), bad = failedFor(id, p.id);
    const desc = C.placeKept({ key, state: p.off === true ? 'off' : 'kept', what: (p.summary ?? []).join('; ') || p.note, editing: !!form && p.off !== true,
        intent: p.note ?? '', preview: form?.lastPreview ?? null, inactive: bad?.inactive ?? '', cantApply: bad && !bad.inactive ? bad.error : '' });
    if (desc.editor) desc.editor.formEl = form.el;
    else desc.extras = [showChangeEl(id, p)];
    const rc = drawCard(desc, 'placeKept', ticketFor('placeKept', { id, msg, p }));
    if (desc.editor && rc._panel) {
        form.diffBox = rc._panel; form.onLive = ops => liveDiff(rc._panel, ops, { changes: chatChanges(ch.slice(0, id)), now: chatElapsed(ch.slice(0, id + 1)) }, form);
        if (!form.lastPreview) form.onLive(form.getOps());
    }
    return rc;
}
const NOTE_FIELD = { npc_fact: ['text', 'Fact'], npc_memory: ['note', 'Memory'], npc_disposition: ['reason', 'Why'] };
/** A person note (and a pending lasting fact): the shared card; Edit opens its text (a remembered person: every field). */
function personNoteEl(msg, id, s, who) {
    const key = `${id}|note|${s.identity?.owner || s.type}|${s.id || ''}|${(msg.extra?.[NPC_KEY] ?? []).indexOf(s)}`;
    const editing = !s.off && !!editLib()?.editorOpen(key);
    const pending = s.pending === true && !s.off;
    let fields = [], rows = [], invented = '';
    if (s.type === 'npc_create') {
        if (editing) { const v = C.rememberValues(s); fields = C.REMEMBER_FIELDS.filter(([k]) => k !== 'starts').map(([k, label, kind]) => ({ key: k, label, value: v[k] ?? '', kind, cls: `worldscrawl_remember_${k}` })); }
        if (!s.off) rows = [['looks', 'Looks'], ['body', 'Body'], ['outfit', 'Wearing'], ['history', 'History']].filter(([k]) => s[k]).map(([k, label]) => ({ field: k, label, before: '', after: s[k] }));
        if (!s.off && s.invented?.length) invented = `Made up to fill gaps (not in the story): ${s.invented.join('; ')}. Change any of it here (Edit) before you export.`;
    } else if (NOTE_FIELD[s.type] && editing) { const [k, label] = NOTE_FIELD[s.type]; fields = [{ key: k, label, value: s[k] ?? '', kind: 'text', cls: 'worldscrawl_note_text' }]; }
    if (pending) rows = [{ field: 'text', label: 'Fact', before: '', after: s.text ?? '' }];
    const title = pending ? `Lasting change for ${who}: ${s.text}` : s.off ? `Character change turned off: ${stampSummary(s, who)}` : `Character changed here: ${stampSummary(s, who)}`;
    const desc = C.personNote({ key, state: pending ? 'review' : s.off ? 'off' : 'kept', title, who, editing, editable: !s.off && (pending || s.type === 'npc_create' || !!NOTE_FIELD[s.type]), fields: s.off ? [] : fields, rows, tag: s.type === 'npc_create' ? 'new person' : 'person', invented });
    return drawCard(desc, 'personNote', ticketFor('personNote', { id, msg, s, key }));
}
/** A person found at a place: the shared card; Edit opens the room box. */
function foundEl(msg, id, s, who, foundNotes) {
    const key = `${id}|found|${s.id}|${s.where || ''}`, editing = !s.off && !!editLib()?.editorOpen(key);
    const label = a => castPack()?.labels?.[a] || a;
    const note = foundNotes.find(x => x.ok && x.id === s.id && (x.where ?? '') === (s.where ?? ''));
    const title = `${s.where ? `${who}'s "${s.where}" is now ${label(s.place)}, for the rest of this chat.` : `${who} is now placed in ${label(s.place)}, for the rest of this chat.`}${note?.reason ? ` ${note.reason}` : ''}`;
    return drawCard(C.foundKept({ key, state: s.off ? 'off' : 'kept', title, editing, place: s.place ?? '' }), 'found', ticketFor('found', { id, msg, s, key }));
}
/** The Remember card: Preparing… (the prefetch), failed (Check again), or the proposed person with Edit for every field. */
function rememberEl(msg, id, remember) {
    const key = `${id}|remember`, saving = isDecided(msg, remember.nid);
    const prop = remember.proposal?.name === remember.name ? remember.proposal : null;
    if (!prop && !saving) queueMicrotask(() => prefetchRemember(id));
    const phase = prop?.got ? 'review' : prop?.failed ? 'failed' : 'working';
    const editing = phase === 'review' && !saving && !!editLib()?.editorOpen(key);
    const desc = C.rememberReview({ key, name: remember.name, suggested: !!remember.suggested, phase, saving, got: prop?.got ?? null, editing });
    return drawCard(desc, 'remember', ticketFor('remember', { id, msg, card: remember }));
}
/** A kept person (appearance or base text) change: the shared card; Edit opens the same Body/Outfit editor as its review. */
function personKeptEl(msg, id, s, who) {
    const key = `${s.identity.owner}|npcedit`, editing = !!editLib()?.editorOpen(key);
    const base = s.type === 'npc_baseline' || s.committed?.kind === 'baseline';
    const label = f => (f === 'outfit' ? 'Outfit' : 'Body');
    let fields = [];
    if (editing && base) { const f = s.committed?.field || 'body'; fields = [{ key: f, label: label(f), value: s.committed?.text ?? '', cls: 'worldscrawl_npc_text', data: { part: 'lasting', field: f } }]; }
    else if (editing) {
        const chat = ctx().chat ?? [];
        const at = npcAt(chat, id, castPack()?.npcs ?? [], s.id, i => npcClock(chat, i));
        fields = String(s.committed?.fields || 'body,outfit').split(',').map(f => f.trim()).filter(f => f === 'body' || f === 'outfit')
            .map(f => ({ key: f, label: label(f), value: at?.[f] ?? '', cls: 'worldscrawl_npc_text', data: { part: s.lasts > 0 ? 'live' : 'lasting', field: f } }));
    }
    const text = s.off ? `Character change turned off: ${stampSummary(s, who)}` : `Character changed here: ${stampSummary(s, who)}`;
    return drawCard(C.personKept({ key, state: s.off ? 'off' : 'kept', text, editing, intent: s.committed?.intent ?? '', hasIntent: !base, fields }), 'person', ticketFor('person', { msg, s, who }));
}

/**
 * Under a person-expiry notice: the shared expiry card. The panel is how they looked while it lasted next to now;
 * Edit opens the Body/Outfit editor, and Approve edited saves the typed text as a lasting change on this notice.
 */
/** Expiry notices sit right after the message whose turn ran the change out (personExpiryTurn, placeExpiryTurn). */
const isNotice = m => !!(m?.is_system && m.extra?.worldscrawl_notice);
/** The player message an expiry notice belongs to: the rebuild that turn ran is stored there. */
function noticeHost(ch, id) { let h = id - 1; while (h >= 0 && isNotice(ch[h])) h--; return h; }
/** Rebuild jobs on a message (its shown swipe): the stored ones (working / failed), and the calls running now (work.mjs). */
function jobsOf(msg) {
    const stored = appearJobs(msg);
    return [...stored, ...workingOn(msg).filter(w => !stored.some(j => j.id === w.id && j.key === w.key && j.domain === w.domain && j.part === w.part))];
}
/** The name a job's title uses: the person's name as the cards show it, or the place text's label; never a raw id ('' = a plain phrase). */
function jobName(job, npcNames) {
    if (job.domain === 'place') return job.name && job.name !== job.id ? job.name : targetLabel(job.id, castPack()?.labels ?? {});
    return npcNames?.get(job.id) || (job.name && job.name !== job.id ? job.name : '');
}
/** Display names of people (cast and Remember stamps), as the cards show them. */
function personNames(ch) {
    const names = new Map((castPack()?.npcs ?? []).map(n => [n.id, n.name]));
    for (const m of ch) for (const s of m?.extra?.[NPC_KEY] ?? []) if (s?.id && s.name) names.set(s.id, s.name);
    return names;
}
/** A proposal's own call (job.owner): its card shows it, while that proposal is still up. */
function proposalOf(msg, job) {
    if (!job.owner) return null;
    return (msg?.extra?.[NPC_KEY] ?? []).find(s => s && (s.owner === job.owner || s.identity?.owner === job.owner) && s.candidate && !s.off && (s.swipe ?? 0) === swipeOf(msg)) ?? null;
}
/** The place expiry notice items (timed text changes) on a notice. */
const placeItems = m => (m?.extra?.worldscrawl_notice_kind === PLACE_EXPIRED_KIND ? (m.extra.worldscrawl_notice_places ?? []).filter(it => it?.id) : []);
/** Does an expiry notice item cover this rebuild job? A person's by its id; a place text's by the text it wrote. */
const covers = (p, job) => (job.domain === 'place' ? (p.targets ?? []).includes(job.id) : p?.kind === 'appearance' && p.id === job.id);
/** The expiry notice right after message h that names the job's person or place text, or -1. */
function coveringNotice(ch, h, job) {
    for (let i = h + 1; i < ch.length && isNotice(ch[i]); i++) {
        const items = job.domain === 'place' ? placeItems(ch[i]) : ch[i].extra.worldscrawl_notice_kind === NPC_EXPIRED_KIND ? (ch[i].extra.worldscrawl_notice_people ?? []) : [];
        if (items.some(p => covers(p, job))) return i;
    }
    return -1;
}
const shownJob = j => j.status === 'working' || j.status === 'failed';
/** A rebuild after an expiry shows on the expiry notice that covers it (working, or failed with Check again), not as a second card. */
const coveredJob = (ch, id, job) => shownJob(job) && coveringNotice(ch, id, job) >= 0;
/** Drawn on another card (an expiry notice, or the proposal that asked), not as the job card. */
const elsewhere = (ch, id, job) => coveredJob(ch, id, job) || !!proposalOf(ch[id], job);
/** The jobs an expiry card at notice `id` carries for item `p`: those on its host message that this notice covers. */
/** The jobs an expiry card at notice `id` carries for its items (a group): those on its host message this notice covers. */
function cardJobs(chat, id, group) {
    const host = noticeHost(chat, id);
    if (host < 0) return { host, jobs: [] };
    return { host, jobs: jobsOf(chat[host]).filter(j => shownJob(j) && group.some(p => covers(p, j)) && coveringNotice(chat, host, j) === id) };
}
/** A job as the expiry card shows it. */
const jobView = (j, names) => ({ name: jobName(j, names), status: j.status, reason: j.reason ?? '', part: j.part });
/** One card per person on a notice (the collapse rule: their changes that ran out share one rebuild). */
function expiredPersonEl(msg, id, group) {
    const chat = ctx().chat ?? [], p = group[0];
    const { host, jobs } = cardJobs(chat, id, group);
    const failed = jobs.filter(j => j.status === 'failed');
    const ends = Math.min(...group.map(x => Number(x.ends)).filter(Number.isFinite));
    const now = npcAt(chat, id, castPack()?.npcs ?? [], p.id, i => npcClock(chat, i));
    const before = npcBefore(chat, id, p.id, ends); // just before the first of them ran out
    const key = `${msg.extra?.worldscrawl_mid || id}|npcexpired|${p.id}`;
    const edited = (msg.extra?.[NPC_KEY] ?? []).some(s => s?.id === p.id && s.source === 'expiry_edit' && s.committed);
    const rows = now ? ['body', 'outfit'].map(f => ({ field: f, part: 'lasting', label: f === 'body' ? 'Body' : 'Outfit', before: before?.[f] ?? '', after: now[f] ?? '', changed: (before?.[f] ?? '') !== (now[f] ?? '') })) : [];
    const editing = !edited && !!now && !!editLib()?.editorOpen(key);
    const fields = editing ? rows.map(r => ({ key: r.field, label: r.label, value: now[r.field] ?? '', cls: 'worldscrawl_npc_text', data: { part: 'lasting', field: r.field } })) : [];
    const names = personNames(chat), who = names.get(p.id) || p.name || 'Someone';
    return drawCard(C.personExpiry({ key, who, whats: group.map(x => x.what ?? ''), rows, editing, fields, edited: edited || !now, jobs: jobs.map(j => jobView(j, names)) }), 'expiry',
        ticketFor('expiry', { id, msg, key, kind: 'person', person: p, ...(failed.length ? { host, jobs: failed } : {}) }));
}

/**
 * Under a place expiry notice: the shared expiry card (before = with the temporary change, now = without it). `got.item`
 * is one timed text change of a place expiry notice (none: the vanished room); its text rebuild shows on the card
 * (working, or failed with Check again).
 */
function expiredPlaceEl(msg, id, got) {
    const ch = ctx().chat ?? [];
    const item = got.item ?? null, group = got.items ?? [];
    const key = item ? `${id}|expiry|${item.key}@${item.ends}` : `${id}|expiry`, form = openForms.get(key);
    const edited = patchesOn(msg).some(p => p.source === 'expiry_edit' && (!item || group.some(it => p.expiry === it.key)));
    const { host, jobs } = item ? cardJobs(ch, id, group) : { host: -1, jobs: [] };
    const name = castPack()?.labels?.[got.address] || got.name || got.preview?.after?.[got.address]?.name || '';
    const desc = C.placeExpiry({ key, name, whats: item ? group.map(it => it.what ?? '') : undefined, preview: form?.lastPreview ?? got.preview, loadError: got.error, editing: !!form && !edited, intent: got.note ?? got.patch.note ?? '', edited,
        jobs: jobs.map(j => jobView(j)) });
    if (desc.editor) desc.editor.formEl = form.el;
    const failed = jobs.filter(j => j.status === 'failed');
    const rc = drawCard(desc, 'expiry', ticketFor('expiry', { id, msg, key, kind: 'place', got, ...(failed.length ? { host, jobs: failed } : {}) }));
    if (form && !edited && rc._panel) {
        const at = { changes: chatChanges(ch.slice(0, id + 1)), now: chatElapsed(ch.slice(0, id + 1)) };
        form.diffBox = rc._panel; form.onLive = ops => liveDiff(rc._panel, ops, at, form);
        if (!form.lastPreview) form.onLive(form.getOps());
    }
    return rc;
}

/** The clock at a message and after a proposed wait there ("8:00 AM" → "10:00 AM"), or '' when unknown. */
function waitTimes(id, wc) {
    const t = worldTimes.get(activeWorld || defaultWorldId), lib = calendarLib;
    if (!lib?.dateAt || !t) return { before: '', after: '' };
    try {
        const at = chatElapsed((ctx().chat ?? []).slice(0, id + 1));
        const txt = sec => lib.dateAt(sec, t.start_date, t.calendar)?.time ?? '';
        return { before: txt(at), after: txt(at + (Number(wc.seconds) || 0)) };
    } catch { return { before: '', after: '' }; }
}
function waitEl(msg, id, wc) {
    const key = `${id}|wait`, editing = !!editLib()?.editorOpen(key);
    const { before, after } = waitTimes(id, wc);
    return drawCard(C.waitReview({ key, label: wc.label, amount: wc.amount, reason: wc.reason ?? '', before, after: after ? `${after} (${wc.label})` : '', editing }), 'wait', ticketFor('wait', { id, msg }));
}
/** The latest story reply (not the player's line, not an engine notice). */
function latestReply(ch) {
    for (let i = ch.length - 1; i >= 0; i--) { const m = ch[i]; if (m && !m.is_user && !m.is_system && !m.extra?.worldscrawl_notice) return i; }
    return -1;
}
const TRACK_TEXT = { tracking: 'tracking…', tracked: 'tracked', failed: 'tracking failed' };
const TRACK_TITLE = {
    tracking: 'WorldScrawl is reading this reply for map, people and time changes.',
    tracked: 'WorldScrawl read this reply: nothing to add to the map, people or time.',
    failed: 'WorldScrawl could not read this reply for changes (see Debug > Activity log). Nothing was added.',
};
/** The small tracked marker under the latest reply. A card the read put up stands in for it (trackMark gives ''). */
function drawTrackMark(el, msg) {
    const mark = trackMark(msg);
    if (!mark) return;
    const d = document.createElement('div');
    d.className = `worldscrawl_trackmark worldscrawl_trackmark_${mark}`;
    d.textContent = TRACK_TEXT[mark];
    d.title = TRACK_TITLE[mark];
    d.style.cssText = 'margin-top:2px;font-size:0.75em;opacity:0.55;text-align:right;font-style:italic;user-select:none;';
    (el.querySelector('.mes_block') ?? el).appendChild(d);
}
export function renderPatchCards() {
    const ch = ctx().chat ?? [];
    if (isOn()) { refreshChangeStatus(); markUnreadTags(); }
    const latest = latestReply(ch);
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid')), msg = ch[id];
        el.querySelector('.worldscrawl_patchcard')?.remove();
        el.querySelector('.worldscrawl_trackmark')?.remove();
        if (!msg) continue;
        if (id === latest && isOn()) drawTrackMark(el, msg);
        if (abandonStuckAppearance(msg)) { syncSwipeExtra(msg); ctx().saveChat?.(); }
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
        const foundNotes = (msg.extra?.[FOUND_KEY] ?? []).filter(x => x && (x.swipe ?? 0) === swipeOf(msg));
        const npcWarns = (msg.extra?.[NPC_WARN_KEY] ?? []).filter(w => w && (w.swipe ?? 0) === swipeOf(msg));
        const placeWarn = f && (f.swipe ?? 0) === swipeOf(msg) && f.personWarning ? f.personWarning : '';
        const resolved = Object.entries(msg.extra?.[DECIDED_KEY] ?? {}).filter(([nid, d]) => (d?.swipe ?? 0) === swipeOf(msg) && (!nid.startsWith('flag_') || d.action === 'discard') && !(rememberCard && remember.nid === nid));
        const appearPending = jobsOf(msg).some(j => shownJob(j) && !elsewhere(ch, id, j));
        // The collapse rule (C.groupExpiries): one card per rebuild, a person's changes by person, place changes by the text they wrote.
        const expired = msg.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND ? C.groupExpiries((msg.extra.worldscrawl_notice_people ?? []).filter(p => p?.kind === 'appearance' && p.id), p => [p.id]) : [];
        const placeGone = (isPlaceExpiry(msg) ? [expiryView(ch, id)] : C.groupExpiries(placeItems(msg), it => it.targets ?? []).map(g => expiryView(ch, id, g))).filter(Boolean);
        if ((!f || (f.swipe ?? 0) !== swipeOf(msg)) && !kept.length && !waitCard && !rememberCard && !npcStamps.length && !foundNotes.length && !resolved.length && !appearPending && !npcWarns.length && !placeWarn && !expired.length && !placeGone.length) continue;
        const card = document.createElement('div');
        card.className = 'worldscrawl_patchcard';
        card.style.cssText = 'margin-top:6px;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;font-size:0.9em;';
        const line = t => { const d = document.createElement('div'); d.textContent = t; return d; };
        if (!cardLib() || CARD_ADAPTERS.some(a => typeof C?.[a] !== 'function')) { // a missing or older plugin: one line, never the old cards
            const u = line(UPDATE_LINE); u.className = 'worldscrawl_update_plugin'; card.append(u);
            (el.querySelector('.mes_block') ?? el).appendChild(card);
            continue;
        }
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
            const text = flagStatusText(f, id);
            if (text) {
                const desc = C.placeStatus({ key: `${id}|flag`, status: f.status, text });
                if (desc.actions.some(a => a.id === 'again')) desc.extras = [fieldsOf(startPicker())];
                card.append(drawCard(desc, 'place', ticketFor('place', { id })));
            } else if (f.status === 'review' && f.proposal) {
                const here = getStoredLocation();
                // Light touch / full rewrite, laid out like the person card's: only when the change rewrites existing prose.
                const formKey = `${id}|flag`, form = openForms.get(formKey);
                const scoped = !f.proposal.invalid && textTargets(f.proposal).length > 0;
                const desc = C.placeReview({ key: formKey, invalid: !!f.proposal.invalid, summary: f.proposal.summary ?? [], relocateTo: here ? f.proposal.relocate?.[here] ?? '' : '',
                    busy: rewritingOf(f), scoped, full: (f.rewrite ?? f.proposal.rewrite) === 'full', why: f.why ?? '', rewriteError: f.rewriteError ?? '',
                    preview: form?.lastPreview ?? f.proposal, editing: !!form, intent: f.note ?? '', unmerged: !!f.proposal.unmerged?.length, mergedNames: (f.proposal.merged ?? []).map(m => m.to_name) });
                if (desc.editor) desc.editor.formEl = form.el;
                desc.extras = [fieldsOf(startPicker())];
                const rc = drawCard(desc, 'place', ticketFor('place', { id }));
                if (form && rc._panel) { form.diffBox = rc._panel; form.onLive = ops => liveDiff(rc._panel, ops, { changes: chatChanges(ch.slice(0, id + 1)), now: chatElapsed(ch.slice(0, id + 1)) }, form); }
                card.append(rc);
            }
        }
        if (waitCard) card.append(waitEl(msg, id, wc));
        if (rememberCard) card.append(rememberEl(msg, id, remember));
        for (const group of expired) card.append(expiredPersonEl(msg, id, group));
        for (const got of placeGone) card.append(expiredPlaceEl(msg, id, got));
        for (const [, dd] of resolved) card.append(drawCard(C.resolvedNote(dd), 'resolved', null));
        if (placeWarn) card.append(drawCard(C.warnNote(placeWarn), 'warn', null));
        for (const w of npcWarns) card.append(drawCard(C.warnNote(w.text), 'warn', null));
        const npcNames = personNames(ch);
        for (const job of jobsOf(msg)) if (shownJob(job) && !elsewhere(ch, id, job))
            card.append(drawCard(C.appearJob({ key: `${id}|job|${job.id}|${job.key}|${job.part ?? ''}`, name: jobName(job, npcNames), status: job.status, reason: job.reason ?? '', domain: job.domain, part: job.part }), 'job', ticketFor('job', { id, msg, job })));
        let exported = new Set();
        for (const s of npcStamps) {
            if (s.type === 'npc_found') continue; // drawn below, with Edit / Undo
            const who = npcNames.get(s.id) || s.name || s.id;
            if (s.type === 'npc_appearance_cache' || !stampSummary(s, who)) continue;
            if ((s.type === 'npc_appearance' || s.type === 'npc_baseline') && s.candidate && !s.off) { card.append(personCardEl(msg, s, who)); continue; }
            if ((s.type === 'npc_appearance' || s.type === 'npc_baseline') && s.identity?.owner && s.committed) { card.append(personKeptEl(msg, id, s, who)); continue; }
            card.append(personNoteEl(msg, id, s, who));
        }
        for (const s of npcStamps) if (s.type === 'npc_found') card.append(foundEl(msg, id, s, npcNames.get(s.id) || s.id, foundNotes));
        for (const fnd of foundNotes) if (!fnd.ok) {
            const d = line(`Couldn't find ${fnd.name || 'them'}: ${fnd.reason}`);
            d.className = 'worldscrawl_found_rejected';
            card.append(d);
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
        for (const p of kept) box.append(placeKeptEl(msg, id, p));
        if (!card.childNodes.length) continue;
        (el.querySelector('.mes_block') ?? el).appendChild(card);
    }
}

export { cardButton, noteShortWait, stampWait, waitAsk, waitFacts };
