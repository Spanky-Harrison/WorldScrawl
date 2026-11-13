// Narrator generations in flight, and which chat message a turn belongs to. No imports: index.js, doors.mjs and
// scene.mjs all read it.
import { narratorFailure, narratorStart } from './calllog.mjs';

// ---- One record per narrator generation (GENERATION_STARTED, not quiet or dry), oldest first. A second start never
// closes the first: two can run at once (an automatic reply started while another was running).
const live = [];
let groupBusy = false;
const STARTING_MS = 3000; // GENERATION_STARTED to SillyTavern's "generating" flag: its own awaits (commands, ping)
/** SillyTavern's own "a reply is being generated" flag (set when the send buttons lock, cleared when they unlock). */
export const stGenerating = () => { try { return globalThis.document?.body?.dataset?.generating === 'true'; } catch { return false; } };
export function genStarted(chat, type, opts, dry) {
    const g = narratorStart(chat, type, opts, dry);
    if (!g) return null;
    if (!stGenerating()) for (const old of [...live]) genFinish(old); // nothing is running: the older ones ended without an event
    g.t0 = Date.now();
    live.push(g);
    return g;
}
/** A reply landed: it belongs to the oldest generation still waiting for one. */
export function genReceived() { const g = live.find(x => !x.received); if (g) g.received = true; return g ?? null; }
/** Stop aborts the newest request. */
export function genStopped() { const g = [...live].reverse().find(x => !x.received) ?? live[live.length - 1]; if (g) g.stopped = true; return g ?? null; }
export function genError(text) { const g = [...live].reverse().find(x => !x.received && !x.error); if (g) g.error = text; return g ?? null; }
let onFail = null;
/** Who writes the "narrator failed" note: (record, failure) => void. */
export function onGenFailure(fn) { onFail = fn; }
function genFinish(g) {
    const i = live.indexOf(g);
    if (i < 0) return;
    live.splice(i, 1);
    const n = narratorFailure(g);
    if (n && onFail) onFail(g, n);
}
/** GENERATION_ENDED (SillyTavern sends one when the send buttons unlock): close every generation that is done. */
export function genEnded() {
    for (const g of [...live]) if (g.received || g.stopped || !stGenerating()) genFinish(g);
}
export const setGroupBusy = v => { groupBusy = !!v; };
/** A narrator reply is running or about to start (a group is still going through its members). */
export function generating() {
    if (groupBusy || stGenerating()) return true;
    const now = Date.now();
    return live.some(g => !g.received && now - g.t0 < STARTING_MS);
}
/** Resolves once nothing is generating for two checks in a row (and `alsoBusy` is false), or after `timeout` ms. */
export function whenIdle(alsoBusy = () => false, { poll = 100, timeout = 180000 } = {}) {
    return new Promise(resolve => {
        const t0 = Date.now();
        let calm = 0;
        const tick = () => {
            calm = generating() || alsoBusy() ? 0 : calm + 1;
            if (calm >= 2) return resolve(true);
            if (Date.now() - t0 > timeout) return resolve(false);
            setTimeout(tick, poll);
        };
        setTimeout(tick, poll);
    });
}
/** For tests: forget every record. */
export function genReset() { live.length = 0; groupBusy = false; }
export const genLive = () => live.slice();

// ---- Turns
/** A message the narrator never reads: a WorldScrawl notice, a system line, a /hide'd line. */
const offStory = m => !m || m.is_system || m.extra?.worldscrawl_notice;
/** The player's line this turn: the last player message after the last story reply (notices, system and hidden lines
 *  skipped), or -1 when a story reply came after it (a group's later members, an automatic reply). */
export function turnPlayerIndex(chat) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (offStory(m)) continue;
        return m.is_user ? i : -1;
    }
    return -1;
}
/** The message a reply at `at` follows (its turn's host): the nearest earlier message the narrator reads. */
export function hostIndex(chat, at) {
    for (let i = Math.min(at, chat?.length ?? 0) - 1; i >= 0; i--) if (!offStory(chat[i])) return i;
    return -1;
}

// ---- A told expiry, kept on the host of the reply that told it (survives a swipe, a regenerate and a reload)
export const EXPIRY_LINE_KEY = 'worldscrawl_expiry_line';
/** The told expiry that moved the party out of `from`, stamped on a message after `since` (the stamp that put them there). */
export function toldExpiry(chat, from, since = -1) {
    for (let i = (chat?.length ?? 0) - 1; i > since; i--) { const e = chat[i]?.extra?.[EXPIRY_LINE_KEY]; if (e?.from === from && e.to) return { ...e, at: i }; }
    return null;
}
