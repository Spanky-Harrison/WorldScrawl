// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { waitReason } from './words.mjs';
import { DECIDED_KEY, noticeIdOf, newNoticeId, isDecided, markDecided, once, noticeRow, lockRow, markPending, resolvedText } from './notices.mjs';
import { render as P } from './shared.mjs';
import { normName } from './shared.mjs';
import { NPC_KEY, FOUND_KEY, npcAt, recordDiff, foundEditOk, stampSummary } from './npc.mjs';
import { analyzeFlag, clip, flagCardView, isCarrier, loadPatchLib, parseJsonAnswer, removeFromCard, suggestStart } from './carriers.mjs';
import { calendarLib, chatChanges, chatElapsed, defaultWorldId, loadCalendar, placeWeatherNow, weatherLib, worldTimes } from './clock.mjs';
import { baseReply, gen, noteCall } from './dig.mjs';
import { discardFlag, flagMessage, keepFlag, markUnreadTags, syncSwipeExtra, undoFlag, unmergeFlag } from './discovery.mjs';
import { currentLocation, ensurePrompts, getStoredLocation } from './doors.mjs';
import { renderAllExits } from './footer.mjs';
import { FLAG_KEY, WAITCARD_KEY, WAIT_KEY, activeWorld, broadcastMapState, ctx, editChangeInTab, isOn, openCarriers, settings } from './index.js';
import { lastUserIndex, partyText } from './movement.mjs';
import { drawDiff, failedFor, liveDiff, openEditor, openForms, patchesOn, refreshChangeStatus, saveKeptEdit, swipeOf, toggleFromCard } from './patches.mjs';
import { REMEMBER_KEY, applyFacts, castPack, discardRemember, exportNpc, keepRemember, npcEnv, prefetchRemember, refreshLivePlaces, retryRemember } from './scene.mjs';

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
    stampWait(msg, w); delete msg.extra[WAITCARD_KEY];
    renderPatchCards();
    await c.saveChat?.(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
    return '';
}
/** Which temporary changes a re-timed wait now runs past (crossed) or no longer reaches (uncrossed), keyed by change and op. */
export function waitExpiryDelta(changes, start, oldSec, newSec, expiredBetween) {
    const key = g => `${g.id ?? ''}#${g.op ?? g.index ?? ''}#${g.note}`;
    const was = expiredBetween(changes, start, start + oldSec), now = expiredBetween(changes, start, start + newSec);
    const wk = new Set(was.map(key)), nk = new Set(now.map(key));
    return { crossed: now.filter(g => !wk.has(key(g))), uncrossed: was.filter(g => !nk.has(key(g))) };
}
/** Re-time an already-kept wait. The clock moves, so expiries are rechecked: the map is rebuilt from the chat (the server keeps no state). */
export async function editKeptWait(id, amount) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], old = msg?.extra?.[WAIT_KEY];
    if (!old) return { error: 'no kept wait on that message' };
    const w = await planWait(String(amount), old.sleep);
    if (w.error) return { error: w.error };
    const lib = await loadPatchLib();
    const start = chatElapsed(chat.slice(0, id + 1)) - old.seconds;
    const delta = lib?.expiredBetween ? waitExpiryDelta(chatChanges(chat), start, old.seconds, w.seconds, lib.expiredBetween) : { crossed: [], uncrossed: [] };
    stampWait(msg, w);
    await c.saveChat?.(); await applyFacts(); renderAllExits(); broadcastMapState(); renderPatchCards();
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
    const gone = lib?.expiredBetween ? lib.expiredBetween(chatChanges(chat), before, after) : [];
    if (gone.length) lines.push(`While ${who} ${r.w.sleep ? 'slept' : 'waited'}, these temporary changes ran out and are gone now: ${gone.map(g => g.note).join('; ')}.`);
    return lines.join('\n');
}

/** A notice button. decides: answering the notice (Approve / Adjust / Discard...): the first click locks the whole row
 * ("Saving…"), later clicks are ignored, and the notice redraws when the work is done (the write itself is decide-once). */
function cardButton(label, onClick, title = '', decides = false) {
    const b = document.createElement('span');
    b.className = 'menu_button worldscrawl_card_btn'; b.textContent = label; if (title) b.title = title;
    b.style.cssText = 'display:inline-block;padding:2px 8px;margin:0;font-size:0.9em;white-space:nowrap;width:auto;';
    if (decides) b.dataset.decides = '1';
    b.addEventListener('click', e => {
        e.stopPropagation();
        if (!decides) return onClick();
        const row = b.closest('.worldscrawl_notice_row');
        if (row && !lockRow(row)) return; // already saving
        Promise.resolve().then(onClick).catch(err => { console.error('[WorldScrawl] notice', err); toastr.error(`WorldScrawl: ${err?.message || err}`); }).finally(() => { if (row?.isConnected) renderPatchCards(); });
    });
    return b;
}
/** Notice text, then ONE right-aligned button row at the end. */
const rowOf = (...buttons) => noticeRow(document, buttons.flat().filter(Boolean));
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
    d.append(fieldsOf(inp), rowOf(
        cardButton('Approve', () => {
            if (isApp) {
                const next = inp.value.trim() || s.intent;
                if (next !== s.intent) s.by = 'player';
                s.intent = next;
            } else s.text = inp.value.trim() || s.text;
            delete s.pending; done();
        }, `Add this to ${who} for good (with the words in the box)`, true),
        cardButton('Discard', () => { msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s); if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY]; done(); }, 'Do not change this person', true)));
    return d;
}

export function renderPatchCards() {
    const ch = ctx().chat ?? [];
    if (isOn()) { refreshChangeStatus(); markUnreadTags(); }
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid')), msg = ch[id];
        el.querySelector('.worldscrawl_patchcard')?.remove();
        if (!msg) continue;
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
        const resolved = Object.entries(msg.extra?.[DECIDED_KEY] ?? {}).filter(([nid, d]) => (d?.swipe ?? 0) === swipeOf(msg) && (!nid.startsWith('flag_') || d.action === 'discard') && !(rememberCard && remember.nid === nid));
        if ((!f || (f.swipe ?? 0) !== swipeOf(msg)) && !kept.length && !waitCard && !rememberCard && !npcStamps.length && !foundNotes.length && !resolved.length) continue;
        const card = document.createElement('div');
        card.className = 'worldscrawl_patchcard';
        card.style.cssText = 'margin-top:6px;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:6px;font-size:0.9em;';
        const line = t => { const d = document.createElement('div'); d.textContent = t; return d; };
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
                const bs = [view.buttons.includes('Retry') && cardButton('Retry', () => analyzeFlag(id)), view.buttons.includes('Dismiss') && cardButton('Dismiss', () => discardFlag(id))].filter(Boolean);
                if (bs.length) card.append(rowOf(bs));
            } else if (f.status === 'review' && f.proposal) {
                const rc = markPending(document.createElement('div')); rc.classList.add('worldscrawl_flagreview'); card.append(rc);
                { const card = rc; // the review notice: text, diff, fields, then one row
                card.append(line(f.proposal.invalid ? "🗺 The suggested change didn't fit the map. Press Edit to fix it (Approve opens the editor):" : '🗺 Proposed map change:'));
                const ul = document.createElement('ul'); ul.style.margin = '2px 0 4px 1.2em';
                for (const s of f.proposal.summary ?? []) { const li = document.createElement('li'); li.textContent = s; ul.append(li); }
                card.append(ul);
                const here = getStoredLocation();
                if (here && f.proposal.relocate?.[here]) card.append(line(`The party will be moved to ${f.proposal.relocate[here]}.`));
                const diffBox = document.createElement('div'); diffBox.className = 'worldscrawl_diff';
                card.append(diffBox);
                const form = openForms.get(`${id}|flag`);
                drawDiff(diffBox, form?.lastPreview ?? f.proposal);
                if (form) {
                    card.append(form.el); form.diffBox = diffBox;
                    form.onLive = ops => liveDiff(diffBox, ops, { changes: chatChanges(ch.slice(0, id + 1)), now: chatElapsed(ch.slice(0, id + 1)) }, form);
                }
                card.append(fieldsOf(startPicker()), rowOf(cardButton('Check again', () => { openForms.delete(`${id}|flag`); analyzeFlag(id); }, 'Ask again with this story range'),
                    form ? cardButton('Close editor', () => { openForms.delete(`${id}|flag`); renderPatchCards(); }, 'Forget the edits and keep the suggestion as it was')
                        : cardButton('Edit', () => openEditor(`${id}|flag`, f.proposal.ops, { loc: Object.keys(f.proposal.before ?? {})[0] ?? getStoredLocation() ?? '' }), 'Change, add or remove parts of this change before approving it'),
                    !form && f.proposal.unmerged?.length ? cardButton('Make it a new room instead', () => unmergeFlag(id), `Add a separate new room instead of connecting to ${f.proposal.merged.map(m => m.to_name).join(', ')}`) : null,
                    cardButton(form ? 'Approve edited' : 'Approve', () => keepFlag(id), 'Put this change on the map', true), cardButton('Discard', () => { openForms.delete(`${id}|flag`); return discardFlag(id); }, 'Leave the map as it is', true)));
                }
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
            else if (prop?.failed) { const f = line('Could not prepare the card. '); f.className = 'worldscrawl_remember_failed'; f.append(cardButton('Retry', () => retryRemember(id), 'Ask the model again')); d.append(f); }
            else { const w = line(decided ? 'Saving…' : 'Preparing…'); w.className = 'worldscrawl_remember_preparing'; w.style.opacity = '0.75'; d.append(w); }
            d.append(fieldsOf(nameInp, lineInp), rowOf(cardButton('Approve', () => keepRemember(id), prop?.got ? `Save ${prop.got.name} as shown` : `Remember ${remember.name} (saves the card as soon as it is ready)`, true),
                cardButton('Adjust', () => keepRemember(id, { name: nameInp.value, line: lineInp.value }), 'Approve with the name and the sentence in the boxes', true),
                cardButton('Discard', () => discardRemember(id), 'Not this scene. You can be asked again after the scene changes.', true)));
            if (isDecided(msg, remember.nid)) lockRow(d.querySelector('.worldscrawl_notice_row')); // still saving (redrawn mid-save)
            card.append(d);
        }
        for (const [, dd] of resolved) { const r = line(resolvedText(dd)); r.className = 'worldscrawl_notice worldscrawl_resolved'; card.append(r); }
        const npcNames = new Map((castPack()?.npcs ?? []).map(n => [n.id, n.name]));
        for (const m of ch) for (const s of m?.extra?.[NPC_KEY] ?? []) if (s?.id && s.name) npcNames.set(s.id, s.name);
        let exported = new Set();
        for (const s of npcStamps) {
            if (s.type === 'npc_found') continue; // drawn below, with Edit / Undo
            const who = npcNames.get(s.id) || s.name || s.id;
            if (s.pending && !s.off) { card.append(pendingNpcCard(msg, s, who)); continue; } // a lasting change waits for Approve
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
            if (!s.off && (s.type === 'npc_fact' || s.type === 'npc_memory' || s.type === 'npc_disposition' || s.type === 'npc_create' || s.type === 'npc_appearance')) {
                nrow.append(cardButton('Edit', () => {
                    const inp = document.createElement('input');
                    inp.type = 'text'; inp.value = s.type === 'npc_create' ? (s.line ?? '') : (s[textKey] ?? ''); inp.className = 'text_pole';
                    inp.style.cssText = 'width:16em;display:inline-block;margin:0 4px;padding:1px 4px;';
                    inp.addEventListener('click', e => e.stopPropagation());
                    const save = cardButton('Save', () => {
                        if (s.type === 'npc_create') { s.line = inp.value.trim() || s.line; if (s.name) npcNames.set(s.id, s.name); }
                        else {
                            const next = inp.value.trim();
                            if (s.type === 'npc_appearance' && next && next !== s[textKey]) s.by = 'player';
                            s[textKey] = next;
                        }
                        syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); broadcastMapState();
                    });
                    fields.append(inp, save); d.insertBefore(fields, nrow);
                }, 'Edit this note'));
            }
            nrow.append(cardButton(s.off ? 'Turn on' : 'Turn off', () => { s.off = !s.off; syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); }, s.off ? 'Use this note again' : 'Keep the note here but stop using it'));
            nrow.append(cardButton('Undo', () => {
                msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s);
                if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY];
                syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards();
            }, 'Remove this note (deleting the message does the same)'));
            if (!s.off && s.id && !exported.has(s.id)) {
                exported.add(s.id);
                const live = npcAt(ch, ch.length - 1, castPack()?.npcs ?? [], s.id);
                const castNpc = (castPack()?.npcs ?? []).find(n => n.id === s.id && n.ok !== false && n.from !== 'play');
                if (live?.from === 'cast' && castNpc) {
                    nrow.append(cardButton(`Update ${who}`, () => {
                        d.querySelector('.worldscrawl_castdiff')?.remove();
                        const now = npcAt(ctx().chat ?? [], (ctx().chat ?? []).length - 1, castPack()?.npcs ?? [], s.id);
                        const diff = recordDiff(castNpc, now);
                        const box = document.createElement('div');
                        box.className = 'worldscrawl_castdiff';
                        box.style.cssText = 'margin-top:4px;';
                        const pre = document.createElement('pre');
                        pre.style.cssText = 'white-space:pre-wrap;margin:4px 0;font-size:0.9em;';
                        pre.textContent = diff.changed ? diff.text : 'Nothing has changed since the cast file.';
                        box.append(pre);
                        box.append(rowOf(diff.changed && cardButton('Confirm', () => exportNpc(s.id, { update: true }), 'Write this record over the cast file'), cardButton('Cancel', () => { box.remove(); }, 'Leave the cast file as it is')));
                        d.append(box);
                    }, 'Show what would change in the cast file, then write it in place'));
                } else nrow.append(cardButton('Export', () => exportNpc(s.id), 'Write this person into the world\'s cast folder. An existing file is kept.'));
            }
            card.append(d);
            if (d._more) card.append(d._more);
        }
        const placeLabelOf = a => castPack()?.labels?.[a] || a;
        for (const s of npcStamps) {
            if (s.type !== 'npc_found' || s.off) continue;
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
            }, 'Change the room this where-label resolves to'), cardButton('Undo', () => {
                msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s);
                if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY];
                msg.extra[FOUND_KEY] = (msg.extra[FOUND_KEY] ?? []).filter(x => !(x && x.ok && x.id === s.id && (x.where ?? '') === (s.where ?? '') && (x.swipe ?? 0) === swipeOf(msg)));
                if (!msg.extra[FOUND_KEY].length) delete msg.extra[FOUND_KEY];
                syncSwipeExtra(msg); ctx().saveChat?.(); applyFacts(); renderPatchCards(); broadcastMapState();
            }, 'Remove this find (deleting the message does the same)'));
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
                d.append(rowOf(cardButton('Turn on', () => toggleFromCard(id, p.id), 'Put this change back on the map')));
                box.append(d);
                continue;
            }
            const d = line(`🗺 Map changed here: ${what}`);
            const key = `${id}|${p.id}`, form = openForms.get(key);
            d.append(rowOf(form ? cardButton('Close editor', () => { openForms.delete(key); renderPatchCards(); }) : cardButton('Edit', () => editChangeInTab(id, p, () => openEditor(key, p.ops)), 'Change this kept change in the map editor (a new tab); it stays on this message'),
                ...(failedFor(id, p.id)?.inactive ? [] : [cardButton('Turn off', () => toggleFromCard(id, p.id), 'Take this change off the map for now (it stays here; turn it on again any time)')]),
                cardButton('Undo', () => { if (isCarrier(msg)) removeFromCard(id, p.id); else { if (f) f.patch = p.id; else { msg.extra[FLAG_KEY] = { patch: p.id }; } undoFlag(id); } }, 'Remove this change (deleting the message does the same)')));
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
