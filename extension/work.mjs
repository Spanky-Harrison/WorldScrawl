// Model side calls in flight, shown while they run: no call that can take more than a few seconds is silent. Live only
// (a reload shows none, so nothing can be stuck "working"). A rebuild registers a working job on the message it stores
// its result or failure on; the cards draw these next to the stored jobs (waits.mjs jobsOf): on the expiry card that
// covers them, on the proposal card that asked (job.owner), or as the shared job card.
const live = new Map(); // token -> {msg, swipe, job}
let listener = null, queued = false;
/** The card layer redraws when work starts or ends (waits.mjs registers renderPatchCards). */
export function onWorkChange(fn) { listener = fn; }
function changed() {
    if (queued || !listener) return;
    queued = true;
    // After the current step: a call that just ended has written its result or failure by then.
    setTimeout(() => { queued = false; try { listener(); } catch (e) { console.warn('[WorldScrawl] redraw', e?.message || e); } }, 0);
}
/** Register a working job on `msg` (its shown swipe). Returns end(), safe to call twice. */
export function beginWork(msg, job) {
    if (!msg) return () => {};
    const token = Symbol('work');
    live.set(token, { msg, swipe: msg.swipe_id ?? 0, job: { ...job, status: 'working' } });
    changed();
    return () => { if (live.delete(token)) changed(); };
}
/** Run `fn` with a working job shown on `msg`. */
export async function withWork(msg, job, fn) {
    const end = beginWork(msg, job);
    try { return await fn(); } finally { end(); }
}
/** The working jobs on message `msg` (its shown swipe). */
export function workingOn(msg) {
    return [...live.values()].filter(w => w.msg === msg && w.swipe === (msg?.swipe_id ?? 0)).map(w => w.job);
}
