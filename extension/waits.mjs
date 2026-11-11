// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { waitReason } from './words.mjs';
import { DECIDED_KEY, noticeIdOf, newNoticeId, isDecided, markDecided, once, resolvedText } from './notices.mjs';
import { render as P, cards as C } from './shared.mjs';
import { UPDATE_LINE, cardLib, editLib } from './cardlib.mjs';
import { runCardAction, ticketFor } from './cardacts.mjs';
import { normName } from './shared.mjs';
import { NPC_KEY, NPC_WARN_KEY, FOUND_KEY, npcAt, fileDiff, foundEditOk, reviewSummary, stampSummary } from './npc.mjs';
import { analyzeFlag, clip, flagCardView, isCarrier, loadPatchLib, parseJsonAnswer, removeFromCard, rewritingOf, suggestStart } from './carriers.mjs';
import { textTargets } from './arearewrite.mjs';
import { calendarLib, chatChanges, chatElapsed, defaultWorldId, loadCalendar, placeWeatherNow, weatherLib, worldTimes } from './clock.mjs';
import { baseReply, gen, noteCall } from './dig.mjs';
import { discardFlag, flagMessage, markUnreadTags, syncSwipeExtra, undoFlag } from './discovery.mjs';
import { currentLocation, ensurePrompts, getStoredLocation } from './doors.mjs';
import { renderAllExits } from './footer.mjs';
import { FLAG_KEY, WAITCARD_KEY, WAIT_KEY, activeWorld, broadcastMapState, ctx, editChangeInTab, hooks, isOn, openCarriers, settings } from './index.js';
import { lastUserIndex, partyText } from './movement.mjs';
import { failedFor, liveDiff, openEditor, openForms, patchesOn, refreshChangeStatus, saveKeptEdit, swipeOf, toggleFromCard } from './patches.mjs';
import { APPEAR_KEY, REMEMBER_KEY, abandonStuckAppearance, appearJobs, applyFacts, castPack, discardRemember, editExpiryRevert, exportNpc, keepRemember, npcClock, npcEnv, personExpiriesIn, postPersonExpiryNotices, prefetchRemember, refreshLivePlaces, retryRemember, settleNpc } from './scene.mjs';
import { NPC_EXPIRED_KIND, changeLabel } from './npcexpiry.mjs';
import { decideNpc, fillCandidate } from './owners.mjs';
import { reviewFields } from './replay.mjs';

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
/** A narrator wait waits for the player: Keep, Adjust or Discard on a card (unless Auto-keep waits is on). */
const waitAsk = () => (settings().autoKeepWaits ? '' : ' (The player will confirm it.)');
/** The amount as the player would type it: "until morning", "2h 30m". */
export const waitAmount = w => (w.until ? `until ${w.until}` : calendarLib?.formatDuration ? calendarLib.formatDuration(w.seconds) : `${Math.round(w.seconds / 60)}m`);
export function proposeWait(msg, w) {
    msg.extra = msg.extra ?? {};
    msg.extra[WAITCARD_KEY] = { nid: newNoticeId('wait'), swipe: swipeOf(msg), seconds: w.seconds, sleep: !!w.sleep, label: w.label, until: w.until ?? null, amount: waitAmount(w), reason: w.reason || '' };
}
/** Keep (amount unchanged) or Adjust (a new amount) a proposed wait: the same stamp as a narrator wait kept at once. */
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
    await c.saveChat?.(); await postPersonExpiryNotices(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
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
    await c.saveChat?.(); if (delta.crossed.length) await postPersonExpiryNotices(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
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
    if (gone.length) lines.push(`While ${who} ${r.w.sleep ? 'slept' : 'waited'}, these temporary changes ran out and are gone now: ${gone.map(g => g.note).join('; ')}.${gone.some(g => g.person) ? ' Describe the people as they are now (see the people listed).' : ''}`);
    return lines.join('\n');
}

/** A notice button (the shared card button): decides locks the row on the first click and redraws the cards after. */
const cardHooks = { onError: err => { console.error('[WorldScrawl] notice', err); toastr.error(`WorldScrawl: ${err?.message || err}`); }, after: () => renderPatchCards() };
function cardButton(label, onClick, title = '', decides = false) { return cardLib().cardButton(document, label, onClick, title, decides, cardHooks); }
const markPending = el => cardLib().markPending(el);
const lockRow = (row, text) => cardLib().lockRow(row, text);
/** Draw a shared card; its clicks go through the action layer with the ticket taken now. */
function drawCard(desc, type, ticket) { return cardLib().renderCard(document, desc, (id, a) => runCardAction(type, id, ticket, a), cardHooks); }
/** Notice text, then ONE right-aligned button row at the end. */
const rowOf = (...buttons) => cardLib().noticeRow(document, buttons.flat().filter(Boolean));
const fieldsOf = (...els) => { const f = document.createElement('div'); f.className = 'worldscrawl_notice_fields'; f.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;'; f.append(...els.filter(Boolean)); return f; };
/** The proposed card on a Remember notice: what Approve will save. Invented details are marked. */
function rememberProposalEl(got) {
    const box = document.createElement('div');
    box.className = 'worldscrawl_remember_proposal';
    box.style.cssText = 'margin:3px 0 3px 1em;font-size:0.92em;';
    const head = document.createElement('div');
    head.className = 'worldscrawl_remember_head';
    head.textContent = `${got.name}${got.unknownAs ? ` (shown as "${got.unknownAs}" until the name is learned)` : ''}: ${got.line}${got.looks ? ` — ${got.looks}` : ''}`;
    box.append(head);
    const rows = [['Manner', got.manner], ['Speech', got.voice], ['Body', got.body], ['Wearing', got.outfit], ['History', got.history],
        ['Starts', got.disposition ? `${got.disposition.value}${got.disposition.reason ? ` (${got.disposition.reason})` : ''}` : ''], ['Facts', (got.facts ?? []).join('; ')]].filter(([, v]) => v);
    if (rows.length || got.invented?.length) {
        const det = document.createElement('details');
        det.className = 'worldscrawl_remember_details';
        const sum = document.createElement('summary'); sum.textContent = 'Details'; det.append(sum);
        det.addEventListener('click', e => e.stopPropagation());
        for (const [k, v] of rows) { const r = document.createElement('div'); r.textContent = `${k}: ${v}`; det.append(r); }
        if (got.invented?.length) {
            const v = document.createElement('div'); v.className = 'worldscrawl_invented';
            v.textContent = `Made up to fill gaps (not in the story): ${got.invented.map(x => `⚠ ${x}`).join('; ')}`;
            det.append(v);
        }
        box.append(det);
    }
    return box;
}
/** Flag buttons on messages and the Keep / Discard cards (DOM only; never in message text). */
/** A lasting character change the model asked for: nothing changes until Approve (Edit, then Approve, changes the words). */
function pendingNpcCard(msg, s, who) {
    const d = markPending(document.createElement('div')); d.classList.add('worldscrawl_npcpending');
    const isApp = s.type === 'npc_appearance';
    const label = isApp ? `Lasting appearance for ${who}: ${s.intent}` : `Lasting change for ${who}: ${s.text}`;
    const t = document.createElement('div'); t.textContent = label; d.append(t);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = isApp ? (s.intent ?? '') : (s.text ?? ''); inp.className = 'text_pole';
    inp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
    inp.addEventListener('click', e => e.stopPropagation());
    const done = () => { syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); broadcastMapState(); }; // the map's cast panel follows the decision
    if (isApp) {
        const mid = (ctx().chat ?? []).indexOf(msg);
        const live = mid >= 0 ? npcAt(ctx().chat ?? [], mid, castPack()?.npcs ?? [], s.id) : null;
        if (live) for (const [k, label] of [['looks', 'Looks'], ['body', 'Body'], ['outfit', 'Wearing']]) {
            const row = document.createElement('div');
            row.className = 'worldscrawl_appeardiff';
            row.textContent = `${label} now: ${live[k] || '—'}`;
            d.append(row);
        }
    }
    d.append(fieldsOf(inp), rowOf(
        cardButton('Approve', () => {
            if (isApp) {
                const next = inp.value.trim() || s.intent;
                if (next !== s.intent) s.by = 'player';
                s.intent = next;
            } else s.text = inp.value.trim() || s.text;
            delete s.pending; done();
            if (isApp) return;
        }, `Add this to ${who} for good (with the words in the box)`, true),
        cardButton('Discard', () => { msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s); if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY]; done(); }, 'Do not change this person', true)));
    return d;
}

/** The text boxes Edit shows: the result this change writes (lasting, or for now when it wears off), plus for now when a temporary change sits on top. */
function editRows(c) {
    if (!c?.lastingPreview || !c?.livePreview) return [];
    const temp = c.proposedLasts > 0, both = !temp && c.liveKey !== c.lastingKey;
    const rows = [];
    if (!temp) for (const [field, name] of [['body', 'Body'], ['outfit', 'Outfit']]) rows.push({ part: 'lasting', field, label: `${name}${both ? ' (lasting)' : ''}` });
    if (temp || both) for (const [field, name] of [['body', 'Body'], ['outfit', 'Outfit']]) rows.push({ part: 'live', field, label: `${name} (for now)` });
    return rows;
}
/** The review card for a person's appearance change: the shared card (summary list, red/green panel, one row). */
function personCardEl(msg, s, who) {
    const key = `${s.identity?.owner}|npcedit`;
    const c = s.candidate, phase = c?.phase || 'working';
    const rows = phase === 'review' && c.lastingPreview && c.livePreview ? reviewFields(c) : [];
    const scoped = !!c && c.kind !== 'baseline' && s.kind !== 'baseline';
    const editing = !!editLib()?.editorOpen(key);
    // The proposed text itself, editable like the place editor's fields; Approve edited keeps exactly this.
    const fields = editing && phase === 'review' ? editRows(c).map(r => ({ key: `${r.part}.${r.field}`, label: r.label, value: (r.part === 'live' ? c.livePreview : c.lastingPreview)?.[r.field] ?? '', cls: 'worldscrawl_npc_text', data: { part: r.part, field: r.field } })) : [];
    const desc = C.personReview({ key, who, phase, summary: phase === 'review' ? reviewSummary(c, who, rows) : [], panelRows: phase === 'review' ? reviewFields(c, { all: true }) : [],
        scoped, heavy: scoped && c.scope === 'heavy', why: c?.why ?? '', clockError: c?.clockError ?? '', editing, intent: c?.intent ?? '', fields });
    return drawCard(desc, 'person', ticketFor('person', { msg, s, who }));
}

/**
 * Under a person-expiry notice: what they look like now, and Edit, which opens the same Body/Outfit boxes as the
 * person card's editor. Approve edited saves the typed text as a lasting appearance change on this notice.
 */
function expiredPersonCard(msg, id, p) {
    const d = document.createElement('div');
    d.className = 'worldscrawl_npcexpired';
    const chat = ctx().chat ?? [];
    const live = npcAt(chat, id, castPack()?.npcs ?? [], p.id, i => npcClock(chat, i));
    const edited = (msg.extra?.[NPC_KEY] ?? []).some(s => s?.id === p.id && s.source === 'expiry_edit' && s.committed);
    for (const [k, label] of [['body', 'Body'], ['outfit', 'Outfit']]) {
        const row = document.createElement('div');
        row.className = 'worldscrawl_appeardiff';
        row.textContent = `${label} now: ${live?.[k] || '—'}`;
        d.append(row);
    }
    const formKey = `${msg.extra?.worldscrawl_mid || id}|npcexpired|${p.id}`;
    const open = openForms.get(formKey);
    if (open && live) {
        for (const [field, name] of [['body', 'Body'], ['outfit', 'Outfit']]) {
            const ta = document.createElement('textarea');
            ta.className = 'text_pole worldscrawl_npc_text';
            ta.dataset.part = 'lasting'; ta.dataset.field = field;
            ta.rows = 3; ta.value = open.text[field] ?? '';
            ta.style.cssText = 'width:100%;margin:2px 0;padding:2px 4px;';
            ta.addEventListener('click', e => e.stopPropagation());
            ta.addEventListener('input', () => { open.text[field] = ta.value; });
            const cap = document.createElement('div'); cap.className = 'wsdiff-label'; cap.textContent = name;
            d.append(cap, ta);
        }
    }
    if (!live || edited) return d; // after a saved edit, that change's own row has Edit / Turn off / Undo
    d.append(rowOf(open
        ? [cardButton('Close editor', () => { openForms.delete(formKey); renderPatchCards(); }, 'Forget the edits'),
            cardButton('Approve edited', () => once(`npcexpired-ok:${formKey}`, async () => {
                const res = await editExpiryRevert(ctx().chat.indexOf(msg), p.id, { ...open.text });
                if (res?.ok) openForms.delete(formKey);
                else if (res?.error) toastr.warning(`WorldScrawl: ${res.error}`);
                syncSwipeExtra(msg); await ctx().saveChat?.(); await applyFacts(); renderPatchCards(); broadcastMapState();
                return res;
            }), `Keep ${p.name || p.id}'s body and outfit exactly as typed in the boxes`, true)]
        : [cardButton('Edit', () => { openForms.set(formKey, { text: { body: live.body ?? '', outfit: live.outfit ?? '' } }); renderPatchCards(); }, `Change what ${p.name || p.id} went back to`)]));
    return d;
}

export function renderPatchCards() {
    const ch = ctx().chat ?? [];
    if (isOn()) { refreshChangeStatus(); markUnreadTags(); }
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid')), msg = ch[id];
        el.querySelector('.worldscrawl_patchcard')?.remove();
        if (!msg) continue;
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
        const appearPending = appearJobs(msg).some(j => j.status === 'working' || j.status === 'failed');
        const expired = msg.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND ? (msg.extra.worldscrawl_notice_people ?? []).filter(p => p?.kind === 'appearance' && p.id) : [];
        if ((!f || (f.swipe ?? 0) !== swipeOf(msg)) && !kept.length && !waitCard && !rememberCard && !npcStamps.length && !foundNotes.length && !resolved.length && !appearPending && !npcWarns.length && !placeWarn && !expired.length) continue;
        const card = document.createElement('div');
        card.className = 'worldscrawl_patchcard';
        card.style.cssText = 'margin-top:6px;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;font-size:0.9em;';
        const line = t => { const d = document.createElement('div'); d.textContent = t; return d; };
        if (!cardLib() || !C?.placeReview) { // a missing or older plugin: one line, never the old cards
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
            const view = flagCardView(f, id);
            if (view && view.buttons[0] !== 'review') {
                const t = line(view.text); t.className = `worldscrawl_flag_${f.status}`; card.append(t);
                if (view.buttons.includes('Retry')) card.append(fieldsOf(startPicker()));
                const bs = [view.buttons.includes('Retry') && cardButton('Retry', () => once(`flag-retry:${id}`, () => analyzeFlag(id)), 'Ask again', true), view.buttons.includes('Dismiss') && cardButton('Dismiss', () => discardFlag(id), 'Dismiss this notice', true)].filter(Boolean);
                if (bs.length) card.append(rowOf(bs));
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
        if (waitCard) {
            const d = markPending(document.createElement('div')); d.classList.add('worldscrawl_waitcard');
            d.append(line(`⏳ The narrator passed time: ${wc.label}.`));
            if (wc.reason) { const r = line(`Why: ${wc.reason}`); r.className = 'worldscrawl_wait_reason'; d.append(r); }
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = wc.amount; inp.className = 'text_pole worldscrawl_wait_amount'; inp.title = 'e.g. 45m, 2h, 1h30m, until dawn';
            inp.style.cssText = 'width:9em;display:inline-block;margin:0 4px;padding:1px 4px;';
            inp.addEventListener('click', e => e.stopPropagation());
            const note = line('A shortened or discarded wait may disagree with the story text; swipe the reply to fix that.');
            note.style.opacity = '0.7'; note.style.fontSize = '0.9em';
            d.append(fieldsOf('Amount:', inp), note, rowOf(cardButton('Approve', () => keepWait(id), `Let ${wc.amount} pass`, true), cardButton('Adjust', () => keepWait(id, inp.value), 'Let the amount in the box pass instead', true),
                cardButton('Discard', () => discardWait(id), 'No time passes', true)));
            card.append(d);
        }
        if (rememberCard) {
            const d = markPending(document.createElement('div')); d.classList.add('worldscrawl_remembercard');
            d.append(line(remember.suggested ? `Remember ${remember.name}? They have come up a few times.` : `Remember ${remember.name}?`));
            const nameInp = document.createElement('input');
            nameInp.type = 'text'; nameInp.value = remember.name; nameInp.className = 'text_pole worldscrawl_remember_name';
            nameInp.style.cssText = 'width:10em;display:inline-block;margin:0 4px;padding:1px 4px;';
            nameInp.addEventListener('click', e => e.stopPropagation());
            const lineInp = document.createElement('input');
            lineInp.type = 'text'; lineInp.placeholder = 'one sentence (optional)'; lineInp.className = 'text_pole worldscrawl_remember_line';
            lineInp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
            lineInp.addEventListener('click', e => e.stopPropagation());
            const decided = isDecided(msg, remember.nid);
            const prop = remember.proposal?.name === remember.name ? remember.proposal : null;
            if (!prop && !decided) queueMicrotask(() => prefetchRemember(id));
            if (prop?.got) d.append(rememberProposalEl(prop.got));
            else if (prop?.failed) { const f = line('Could not prepare the card. '); f.className = 'worldscrawl_remember_failed'; f.append(cardButton('Retry', () => once(`remember-retry:${id}`, () => retryRemember(id)), 'Ask the model again', true)); d.append(f); }
            else { const w = line(decided ? 'Saving…' : 'Preparing…'); w.className = 'worldscrawl_remember_preparing'; w.style.opacity = '0.75'; d.append(w); }
            d.append(fieldsOf(nameInp, lineInp), rowOf(cardButton('Approve', () => keepRemember(id), prop?.got ? `Save ${prop.got.name} as shown` : `Remember ${remember.name} (saves the card as soon as it is ready)`, true),
                cardButton('Adjust', () => keepRemember(id, { name: nameInp.value, line: lineInp.value }), 'Approve with the name and the sentence in the boxes', true),
                cardButton('Discard', () => discardRemember(id), 'Not this scene. You can be asked again after the scene changes.', true)));
            if (isDecided(msg, remember.nid)) lockRow(d.querySelector('.worldscrawl_notice_row')); // still saving (redrawn mid-save)
            card.append(d);
        }
        for (const p of expired) card.append(expiredPersonCard(msg, id, p));
        for (const [, dd] of resolved) { const r = line(resolvedText(dd)); r.className = 'worldscrawl_notice worldscrawl_resolved'; card.append(r); }
        const warnLine = text => { const d = line(`⚠ ${text}`); d.className = 'worldscrawl_npcwarn'; return d; };
        if (placeWarn) card.append(warnLine(placeWarn));
        for (const w of npcWarns) card.append(warnLine(w.text));
        const npcNames = new Map((castPack()?.npcs ?? []).map(n => [n.id, n.name]));
        for (const m of ch) for (const s of m?.extra?.[NPC_KEY] ?? []) if (s?.id && s.name) npcNames.set(s.id, s.name);
        for (const job of appearJobs(msg)) {
            if (job.status === 'working') {
                const d = line(`Appearance rebuild for ${job.name || job.id}: working…`);
                d.className = 'worldscrawl_appearpending';
                card.append(d);
            } else if (job.status === 'failed') {
                const d = markPending(document.createElement('div'));
                d.classList.add('worldscrawl_appearpending');
                const t = line(`Appearance rebuild for ${job.name || job.id} failed.`);
                t.className = 'worldscrawl_remember_failed';
                const why = job.reason ? ` ${job.reason}` : '';
                t.textContent = `Appearance rebuild for ${job.name || job.id} failed.${why}`;
                d.append(t, rowOf(cardButton('Retry', () => retryAppearance(id, job.id, job.key), 'Ask the model again to rewrite the appearance', true)));
                card.append(d);
            }
        }
        let exported = new Set();
        for (const s of npcStamps) {
            if (s.type === 'npc_found') continue; // drawn below, with Edit / Undo
            const who = npcNames.get(s.id) || s.name || s.id;
            if (s.type === 'npc_appearance_cache' || !stampSummary(s, who)) continue;
            if ((s.type === 'npc_appearance' || s.type === 'npc_baseline') && s.candidate && !s.off) { card.append(personCardEl(msg, s, who)); continue; }
            if (s.pending && !s.off) { card.append(pendingNpcCard(msg, s, who)); continue; }
            const d = line(s.off ? `Character change turned off: ${stampSummary(s, who)}` : `Character changed here: ${stampSummary(s, who)}`);
            d.className = 'worldscrawl_npcchange';
            if (s.type === 'npc_create' && !s.off && (s.looks || s.body || s.outfit || s.history || s.invented?.length)) {
                const more = document.createElement('div');
                more.className = 'worldscrawl_npccreate_more';
                more.style.cssText = 'font-size:0.9em;opacity:0.85;margin:2px 0 2px 1em;';
                for (const [k, label] of [['looks', 'Looks'], ['body', 'Body'], ['outfit', 'Wearing'], ['history', 'History']]) if (s[k]) { const a = document.createElement('div'); a.textContent = `${label}: ${s[k]}`; more.append(a); }
                if (s.invented?.length) { const v = document.createElement('div'); v.className = 'worldscrawl_invented'; v.textContent = `Made up to fill gaps (not in the story): ${s.invented.join('; ')}. Change any of it in the map's cast panel (In this chat) before you export.`; more.append(v); }
                d._more = more;
            }
            if (s.off) d.style.opacity = '0.6';
            const nrow = rowOf(); const fields = fieldsOf(); d.append(nrow);
            const textKey = s.type === 'npc_memory' ? 'note' : s.type === 'npc_disposition' ? 'reason' : s.type === 'npc_appearance' ? 'intent' : 'text';
            if (!s.off && (s.type === 'npc_fact' || s.type === 'npc_memory' || s.type === 'npc_disposition' || s.type === 'npc_create' || s.type === 'npc_appearance' || s.type === 'npc_baseline')) {
                nrow.append(cardButton('Edit', () => {
                    const appearance = s.type === 'npc_appearance' || s.type === 'npc_baseline';
                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.value = s.type === 'npc_create' ? (s.line ?? '') : appearance ? (s.committed?.intent || s.candidate?.intent || s.intent || '') : (s[textKey] ?? '');
                    inp.className = 'text_pole';
                    inp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
                    inp.addEventListener('click', e => e.stopPropagation());
                    const bodyInp = document.createElement('input');
                    const outfitInp = document.createElement('input');
                    if (appearance && s.type === 'npc_appearance') {
                        bodyInp.type = 'text'; bodyInp.className = 'text_pole'; bodyInp.placeholder = 'Layer body';
                        bodyInp.value = s.committed?.layer?.body || s.candidate?.layer?.body || '';
                        outfitInp.type = 'text'; outfitInp.className = 'text_pole'; outfitInp.placeholder = 'Layer outfit';
                        outfitInp.value = s.committed?.layer?.outfit || s.candidate?.layer?.outfit || '';
                        for (const box of [bodyInp, outfitInp]) { box.style.cssText = inp.style.cssText; box.addEventListener('click', e => e.stopPropagation()); }
                    }
                    const save = cardButton('Save', async () => {
                        if (s.type === 'npc_create') { s.line = inp.value.trim() || s.line; if (s.name) npcNames.set(s.id, s.name); }
                        const ident = s.identity;
                        const chat = ctx().chat ?? [];
                        const elapsed = npcClock(chat, Math.max(0, chat.length - 1)).elapsed;
                        if (ident && appearance) {
                            const layer = s.type === 'npc_baseline' ? (s.committed?.layer || s.candidate?.layer || {}) : { ...(bodyInp.value.trim() ? { body: bodyInp.value.trim() } : {}), ...(outfitInp.value.trim() ? { outfit: outfitInp.value.trim() } : {}) };
                            const fields = [layer.body && 'body', layer.outfit && 'outfit'].filter(Boolean).join(',') || s.committed?.fields || s.candidate?.fields || 'body,outfit';
                            const payload = s.type === 'npc_baseline'
                                ? { field: s.committed?.field || s.candidate?.field || 'body', text: inp.value.trim(), lasts: s.lasts }
                                : { intent: inp.value.trim(), layer, fields, lasts: s.lasts };
                            const edited = decideNpc(chat, ident, s.decisionRev ?? 1, 'edit', payload);
                            if (edited?.refill) await fillCandidate(chat, ident, { baseline: npcAt(chat, chat.length - 1, castPack()?.npcs ?? [], s.id)?.pinned, name: who, elapsed });
                        } else if (ident) {
                            const payload = s.type === 'npc_memory' ? { note: inp.value.trim() } : s.type === 'npc_disposition' ? { reason: inp.value.trim() } : s.type === 'npc_create' ? { line: inp.value.trim() } : { text: inp.value.trim() };
                            decideNpc(chat, ident, s.decisionRev ?? 1, 'edit', payload);
                        } else if (s.type === 'npc_create') s.line = inp.value.trim() || s.line;
                        else s[textKey] = inp.value.trim();
                        syncSwipeExtra(msg); await ctx().saveChat?.(); await applyFacts(); renderPatchCards(); broadcastMapState();
                    });
                    fields.append(...[inp, appearance && s.type === 'npc_appearance' ? bodyInp : null, appearance && s.type === 'npc_appearance' ? outfitInp : null, save].filter(Boolean)); d.insertBefore(fields, nrow);
                }, s.type === 'npc_appearance' || s.type === 'npc_baseline' ? 'Edit the intent and the layer text. The composed preview stays read-only.' : 'Edit this note'));
            }
            const stampKey = `${id}:${s.identity?.owner || s.type}:${s.id || ''}`;
            const act = (action, payload) => once(`npc-${action}:${stampKey}`, async () => {
                const chat = ctx().chat ?? [];
                const res = s.identity ? await settleNpc(chat, s.identity, s.decisionRev ?? 1, action, { ...payload, elapsed: npcClock(chat, Math.max(0, chat.length - 1)).elapsed }) : { ok: false };
                if (!res.ok && !s.identity && action === 'undo') {
                    msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s);
                    if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY];
                } else if (!res.ok && !s.identity && (action === 'off' || action === 'on')) s.off = action === 'off';
                syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); broadcastMapState();
                return res;
            });
            nrow.append(cardButton(s.off ? 'Turn on' : 'Turn off', () => act(s.off ? 'on' : 'off', {}), s.off ? 'Use this note again' : 'Keep the note here but stop using it', true));
            nrow.append(cardButton('Undo', () => act('undo', {}), 'Remove this note (deleting the message does the same)', true));
            card.append(d);
            if (d._more) card.append(d._more);
        }
        const placeLabelOf = a => castPack()?.labels?.[a] || a;
        for (const s of npcStamps) {
            if (s.type !== 'npc_found') continue;
            const who = npcNames.get(s.id) || s.id;
            const note = foundNotes.find(x => x.ok && x.id === s.id && (x.where ?? '') === (s.where ?? ''));
            const d = line(`${s.where ? `${who}'s "${s.where}" is now ${placeLabelOf(s.place)}, for the rest of this chat.` : `${who} is now placed in ${placeLabelOf(s.place)}, for the rest of this chat.`}${note?.reason ? ` ${note.reason}` : ''}`);
            d.className = 'worldscrawl_found';
            const nrow = rowOf();
            const fields = fieldsOf();
            nrow.append(cardButton('Edit', () => {
                const inp = document.createElement('input');
                inp.type = 'text'; inp.value = s.place ?? ''; inp.className = 'text_pole worldscrawl_found_place';
                inp.style.cssText = 'width:18em;display:inline-block;margin:0 4px;padding:1px 4px;';
                inp.addEventListener('click', e => e.stopPropagation());
                const save = cardButton('Save', async () => {
                    await refreshLivePlaces();
                    const loc = await currentLocation();
                    const env = npcEnv(ctx().chat ?? [], loc);
                    const n = npcAt(ctx().chat ?? [], id, castPack()?.npcs ?? [], s.id);
                    const typed = inp.value.trim(), pk = castPack();
                    // By address, or by a room's name on the live map (the first one within the where-label's near).
                    const cands = pk?.places?.has(typed) ? [typed] : [...(pk?.places ?? [])].filter(a => normName(pk.labels?.[a] ?? '') === normName(typed));
                    const tries = (cands.length ? cands : [typed]).map(a => foundEditOk(n, s.where ?? '', a, env));
                    const j = tries.find(t => t.ok) ?? tries[0];
                    if (!j.ok) { toastr.warning(`WorldScrawl: ${j.reason}`); return; }
                    s.place = j.place;
                    syncSwipeExtra(msg); await ctx().saveChat?.(); await applyFacts(); renderPatchCards(); broadcastMapState();
                });
                fields.replaceChildren(inp, save); d.insertBefore(fields, nrow);
            }, 'Change the room this where-label resolves to'), cardButton(s.off ? 'Turn on' : 'Turn off', () => once(`found-off:${id}:${s.id}:${s.where || ''}`, () => settleNpc(ctx().chat ?? [], s.identity, s.decisionRev ?? 1, s.off ? 'on' : 'off', {}).then(() => { syncSwipeExtra(msg); return applyFacts(); }).then(() => { renderPatchCards(); broadcastMapState(); })), s.off ? 'Use this find again' : 'Stop using this find', true), cardButton('Undo', () => once(`found-undo:${id}:${s.id}:${s.where || ''}`, () => settleNpc(ctx().chat ?? [], s.identity, s.decisionRev ?? 1, 'undo', {}).then(() => { syncSwipeExtra(msg); return applyFacts(); }).then(() => { renderPatchCards(); broadcastMapState(); })), 'Remove this find (deleting the message does the same)', true));
            d.append(nrow);
            card.append(d);
        }
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
        for (const p of kept) {
            const what = (p.summary ?? []).join('; ') || p.note;
            if (p.off === true) {
                const d = line(`🗺 Map change turned off: ${what}`);
                d.className = 'worldscrawl_change_off'; d.style.opacity = '0.6';
                d.append(rowOf(cardButton('Turn on', () => once(`map-on:${id}:${p.id}`, () => toggleFromCard(id, p.id)), 'Put this change back on the map', true)));
                box.append(d);
                continue;
            }
            const d = line(`🗺 Map changed here: ${what}`);
            const key = `${id}|${p.id}`, form = openForms.get(key);
            d.append(rowOf(form ? cardButton('Close editor', () => { openForms.delete(key); renderPatchCards(); }) : cardButton('Edit', () => editChangeInTab(id, p, () => openEditor(key, p.ops)), 'Change this kept change in the map editor (a new tab); it stays on this message'),
                ...(failedFor(id, p.id)?.inactive ? [] : [cardButton('Turn off', () => once(`map-off:${id}:${p.id}`, () => toggleFromCard(id, p.id)), 'Take this change off the map for now (it stays here; turn it on again any time)', true)]),
                cardButton('Undo', () => once(`map-undo:${id}:${p.id}`, () => { if (isCarrier(msg)) removeFromCard(id, p.id); else { if (f) f.patch = p.id; else { msg.extra[FLAG_KEY] = { patch: p.id }; } undoFlag(id); } }), 'Remove this change (deleting the message does the same)', true)));
            box.append(d);
            const bad = failedFor(id, p.id);
            if (bad?.inactive) { const w = line(bad.inactive); w.className = 'worldscrawl_inactive'; w.style.opacity = '.6'; box.append(w); }
            else if (bad) { const w = line(`⚠ can't apply: ${bad.error}`); w.className = 'worldscrawl_cant_apply'; w.style.color = '#e55'; box.append(w); }
            if (form) {
                const diffBox = document.createElement('div'); diffBox.className = 'worldscrawl_diff';
                form.onLive = ops => liveDiff(diffBox, ops, { changes: chatChanges(ch.slice(0, id)), now: chatElapsed(ch.slice(0, id + 1)) }, form);
                box.append(form.el, diffBox, cardButton('Save change', () => saveKeptEdit(id, p.id, form)));
                form.onLive(form.getOps());
            }
        }
        if (!card.childNodes.length) continue;
        (el.querySelector('.mes_block') ?? el).appendChild(card);
    }
}

export { cardButton, noteShortWait, stampWait, waitAsk, waitFacts };
