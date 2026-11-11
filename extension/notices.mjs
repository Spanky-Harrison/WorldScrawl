// In-chat notices: decide-once bookkeeping keyed by a stable notice id, and the once() guard.
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

// The card layout (button row, Saving… lock, Waiting on you frame, card CSS) is plugin/ui/card.mjs; this file keeps the
// decisions and the once() guard the engine uses outside cards too.
/** Text for a decided notice. */
export function resolvedText(d) {
    const verb = { approve: 'Approved', adjust: 'Approved (adjusted)', discard: 'Discarded' }[d?.action] ?? 'Done';
    return `✓ ${verb}${d?.text ? `: ${d.text}` : ''}`;
}
