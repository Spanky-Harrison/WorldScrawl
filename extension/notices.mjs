// In-chat notices: one shared layout (text first, ONE right-aligned button row at the end), a "Waiting on you"
// highlight while the engine waits on the player, and decide-once bookkeeping keyed by a stable notice id.
export const DECIDED_KEY = 'worldscrawl_decided'; // msg.extra[DECIDED_KEY] = { [noticeId]: { action, swipe, text } }

let seq = 0;
/** A stable id for a new notice (stored on the card when it is proposed). */
export const newNoticeId = (prefix = 'n') => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The card's id, assigned once (older chats' cards get one the first time they are read). */
export function noticeIdOf(card, prefix = 'n') { if (!card) return null; if (!card.nid) card.nid = newNoticeId(prefix); return card.nid; }
export const decisionOf = (msg, nid) => (nid && msg?.extra?.[DECIDED_KEY]?.[nid]) || null;
export const isDecided = (msg, nid) => !!decisionOf(msg, nid);
/** Record a decision. Returns false (and changes nothing) when that notice was already decided. */
export function markDecided(msg, nid, action, extra = {}) {
    if (!msg || !nid || isDecided(msg, nid)) return false;
    msg.extra = msg.extra ?? {};
    msg.extra[DECIDED_KEY] = { ...(msg.extra[DECIDED_KEY] ?? {}), [nid]: { action, ...extra } };
    return true;
}
/** Take a decision back (the write failed before anything was stamped). */
export function unmarkDecided(msg, nid) {
    const d = msg?.extra?.[DECIDED_KEY]; if (!d?.[nid]) return;
    delete d[nid]; if (!Object.keys(d).length) delete msg.extra[DECIDED_KEY];
}
const inFlight = new Set();
/** Run fn once per key at a time: re-entrant calls while one runs are ignored (return undefined). */
export async function once(key, fn) {
    if (inFlight.has(key)) return undefined;
    inFlight.add(key);
    try { return await fn(); } finally { inFlight.delete(key); }
}
export const busy = key => inFlight.has(key);

/** The button row at the end of a notice (right-aligned). Clicking any button disables the whole row and shows "Saving…". */
export function noticeRow(doc, buttons) {
    const row = doc.createElement('div');
    row.className = 'worldscrawl_notice_row';
    row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px;margin-top:4px;';
    for (const b of buttons.filter(Boolean)) row.append(b);
    return row;
}
/** Lock a row at once (first click): every button disabled, a "Saving…" label. */
export function lockRow(row, text = 'Saving…') {
    if (!row || row.dataset.locked) return false;
    row.dataset.locked = '1';
    for (const b of row.querySelectorAll('.worldscrawl_card_btn')) { b.classList.add('disabled'); b.setAttribute('aria-disabled', 'true'); b.style.pointerEvents = 'none'; b.style.opacity = '0.5'; }
    const s = row.ownerDocument.createElement('span'); s.className = 'worldscrawl_saving'; s.textContent = text; s.style.cssText = 'opacity:.8;font-style:italic;margin-right:auto;';
    row.prepend(s);
    return true;
}
/** Mark a notice as waiting on the player: accent border/background and a "Waiting on you" label first. */
export function markPending(el) {
    el.classList.add('worldscrawl_notice', 'worldscrawl_pending');
    const l = el.ownerDocument.createElement('div'); l.className = 'worldscrawl_waiting_label'; l.textContent = '⏳ Waiting on you';
    el.prepend(l);
    return el;
}
export const NOTICE_CSS = `.worldscrawl_notice.worldscrawl_pending{border:1px solid var(--SmartThemeQuoteColor,#e8a33d)!important;border-left-width:4px!important;background:color-mix(in srgb,var(--SmartThemeQuoteColor,#e8a33d) 12%,transparent);border-radius:6px;padding:4px 8px;margin:4px 0;}
.worldscrawl_waiting_label{font-weight:bold;font-size:.85em;color:var(--SmartThemeQuoteColor,#e8a33d);margin-bottom:2px;}
.worldscrawl_resolved{opacity:.75;font-size:.95em;}`;
/** Text for a decided notice. */
export function resolvedText(d) {
    const verb = { approve: 'Approved', adjust: 'Approved (adjusted)', discard: 'Discarded' }[d?.action] ?? 'Done';
    return `✓ ${verb}${d?.text ? `: ${d.text}` : ''}`;
}
