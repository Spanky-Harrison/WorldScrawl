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

// ---- Every model call, live. The rule: no model call is silent. gen() (dig.mjs) is the one place the extension
// calls the model, and it runs every call through withCall. A call whose card already says it is working names that
// card in `shown`; every other call shows on the shared busy line under the latest message (waits.mjs drawBusy):
// "WorldScrawl: reading your move…". Live only, like the jobs above.
/** Where a call already shows, so the busy line leaves it out: 'card' (its card says working: a rebuild's expiry, job
 *  or proposal card, a map change card, the Remember card), 'marker' (the tracked marker's "tracking…"), 'map' (the
 *  map window's own button). */
export const CALL_SHOWN = ['card', 'marker', 'map'];
const CALL_LABELS = [
    [/^intent/, 'reading your move'],
    [/^pick: (look target|closed door|view|door)$/, 'working out what you look at'],
    [/^pick: bracket target$/, 'reading your [bracket]'],
    [/^pick: disposition$/, 'working out how they feel about you'],
    [/^pick: who$/, "working out who you're talking to"],
    [/^pick: expiry$/, 'choosing where you end up'],
    [/^discovery \/ dig$/, 'working out the new opening'],
    [/^wait amount$/, 'working out how long you wait'],
    [/^remember/, 'preparing a person to remember'],
    [/^tracker$/, 'reading the reply for changes'],
    [/^map edit/, 'preparing a map change'],
    [/^map expand$/, 'writing text for the map editor'],
    [/^appearance compose$/, 'rebuilding an appearance'],
    [/^looks summary$/, 'writing a Looks line'],
    [/^map rebuild$/, 'rebuilding a place text'],
];
/** A model call's kind (its Activity log name) in plain words. */
export const callLabel = kind => CALL_LABELS.find(([re]) => re.test(String(kind ?? '')))?.[1] ?? 'working';
const calls = new Map(); // token -> {kind, label, shown}
let callListener = null, callQueued = false;
/** The busy line redraws when a call starts or ends (waits.mjs registers drawBusy). */
export function onCallChange(fn) { callListener = fn; }
function callsChanged() {
    if (callQueued || !callListener) return;
    callQueued = true;
    setTimeout(() => { callQueued = false; try { callListener(); } catch (e) { console.warn('[WorldScrawl] busy line', e?.message || e); } }, 0);
}
/** Run one model call `fn`, shown while it runs: on the busy line, or on the card `shown` names. */
export async function withCall(kind, shown, fn) {
    const token = Symbol('call');
    calls.set(token, { kind, label: callLabel(kind), shown: CALL_SHOWN.includes(shown) ? shown : null });
    callsChanged();
    try { return await fn(); } finally { calls.delete(token); callsChanged(); }
}
/** Wait on `fn` (not a model call: the turn waiting for one) with `label` on the busy line while it runs. */
export async function withWait(label, fn) {
    const token = Symbol('wait');
    calls.set(token, { kind: 'wait', label, shown: null });
    callsChanged();
    try { return await fn(); } finally { calls.delete(token); callsChanged(); }
}
/** The calls running now: [{kind, label, shown}]. */
export const liveCalls = () => [...calls.values()];
/** What the busy line says now: each running call no card shows, once. */
export const busyLines = () => [...new Set(liveCalls().filter(c => !c.shown).map(c => c.label))];
