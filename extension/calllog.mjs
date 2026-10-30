// Model-call outcome notes: a small debug record on the message each call belongs to (msg.extra.worldscrawl_calls),
// keyed by swipe so each swipe keeps its own. Not a stamp: undo, rebuilds and snapshots never read it.
export const CALLS_KEY = 'worldscrawl_calls';
export const CALL_CAP = 12;
const clip = (s, n = 120) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const swipeIdx = msg => (Number.isInteger(msg?.swipe_id) ? msg.swipe_id : 0);
/** The notes for one swipe of a message (the shown one by default). */
export const callNotes = (msg, swipe = swipeIdx(msg)) => msg?.extra?.[CALLS_KEY]?.[swipe] ?? [];
/**
 * Record one call outcome on `msg`. note: {kind, status: 'ok'|'failed'|'skipped', reason?, answer?, emitted?, retry?}.
 * retry: true merges with the latest note of the same kind (tries + 1, newest status wins).
 * The whole record is mirrored into every swipe_info extra so swiping away and back keeps it.
 */
export function addCallNote(msg, note, { swipe = swipeIdx(msg), cap = CALL_CAP } = {}) {
    if (!msg) return null;
    msg.extra = msg.extra ?? {};
    const all = { ...((msg.swipe_info ?? []).find(si => si?.extra?.[CALLS_KEY])?.extra[CALLS_KEY] ?? {}), ...(msg.extra[CALLS_KEY] && typeof msg.extra[CALLS_KEY] === 'object' ? msg.extra[CALLS_KEY] : {}) };
    const list = all[swipe] ?? [];
    const n = { kind: clip(note.kind, 40), status: note.status ?? 'ok' };
    if (note.reason) n.reason = clip(note.reason);
    if (note.answer != null && String(note.answer).trim()) n.answer = clip(note.answer, 80);
    if (note.emitted) n.emitted = note.emitted.slice(0, 8).map(e => clip(e, 40));
    const last = list[list.length - 1];
    if (note.retry && last && last.kind === n.kind) { Object.assign(last, n, { tries: (last.tries ?? 1) + 1 }); if (!note.reason) delete last.reason; }
    else list.push(n);
    all[swipe] = list.slice(-cap);
    msg.extra[CALLS_KEY] = all;
    for (const si of msg.swipe_info ?? []) if (si) { si.extra = si.extra ?? {}; si.extra[CALLS_KEY] = all; }
    return n;
}
/** Change the status of the latest note of `kind` (e.g. the answer was read but matched nothing). */
export function markCall(msg, kind, status, reason) {
    const l = callNotes(msg); for (let i = l.length - 1; i >= 0; i--) if (l[i].kind === kind) { l[i].status = status; if (reason) l[i].reason = clip(reason); else delete l[i].reason; return l[i]; }
    return null;
}
/** The narrator reply's note: what it emitted, or explicitly no tool call. */
export const narratorNote = emitted => (emitted.length ? { kind: 'narrator reply', status: 'ok', emitted } : { kind: 'narrator reply', status: 'ok', reason: 'narrator made no tool call' });
