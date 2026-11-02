// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { addCallNote, markCall } from './calllog.mjs';
import { render as P } from './prompts.mjs';
import { loadPatchLib, parseJsonAnswer } from './carriers.mjs';
import { chatElapsed } from './clock.mjs';
import { api } from './doors.mjs';
import { fetchLocationCached } from './footer.mjs';
import { CHANGE_KEY, buildDig, ctx, hasExit, returnName, roomLabel } from './index.js';
import { roomOptions } from './looking.mjs';
import { cleanAnswer, displayName, engineMove, matchKey, optionLines, partyText, sameName, stamp, trimAnswer } from './movement.mjs';
import { mapCtx } from './patches.mjs';

// ---- Narrative digging: "I smash a hole in the wall". Small sequential questions, each validated and retried alone.
/** The shared base reply line ({{reply}}) that every system prompt ends with: one, json or text. */
export const baseReply = kind => P(`pick.base_${kind}`);
export const digSys = () => P('dig.system', { reply: baseReply('json') });
export const DIG_TRIES = 2;
export const pickSys = () => P('pick.system', { reply: baseReply('one') });
export const COMPASS = ['north', 'south', 'east', 'west', 'up', 'down'];
// ---- Model-call notes: every model call the extension makes leaves an outcome on the message it belongs to
// (by default the latest message, the one being handled). Saved soon after, so they survive a reload.
let noteSave = null;
function noteCall(at, note) {
    try {
        const c = ctx(), chat = c.chat ?? [], i = Number.isInteger(at) && at >= 0 ? at : chat.length - 1;
        if (!chat[i] || !addCallNote(chat[i], note)) return;
        clearTimeout(noteSave); noteSave = setTimeout(() => { try { ctx().saveChat?.(); } catch { /* ignore */ } }, 1500);
    } catch { /* never break a turn over a debug note */ }
}
const markLast = (at, kind, status, reason) => { try { const chat = ctx().chat ?? []; markCall(chat[Number.isInteger(at) && at >= 0 ? at : chat.length - 1], kind, status, reason); } catch { /* ignore */ } };
/** One model side call, noted: ok with a short answer, or failed (error or empty answer). retry merges with the last note of that kind. */
async function gen(kind, args, { at, retry = false } = {}) {
    try {
        const raw = await ctx().generateRaw(args);
        noteCall(at, String(raw ?? '').trim() ? { kind, status: 'ok', answer: raw, retry } : { kind, status: 'failed', reason: 'empty answer', retry });
        return raw;
    } catch (e) { noteCall(at, { kind, status: 'failed', reason: e?.message ?? String(e), retry }); throw e; }
}
/** Ask one pick-one question; one retry if the answer matches nothing. */
async function askValid(label, prompt, validate, systemPrompt = pickSys()) {
    for (let i = 0; i < DIG_TRIES; i++) {
        const a = await gen(`pick: ${label}`, { prompt, systemPrompt, responseLength: 60 }, { retry: i > 0 });
        const v = validate(trimAnswer(cleanAnswer(a)));
        if (v == null) markLast(undefined, `pick: ${label}`, 'failed', 'answer matched no option');
        console.log(`[WorldScrawl] dig ${label} (try ${i + 1}): ${JSON.stringify(String(a).slice(0, 80))} -> ${v == null ? 'invalid' : JSON.stringify(v)}`);
        if (v != null) return v;
    }
    return null;
}
/** Rooms near `loc` over the map (any exit, hidden too; name/area/first sentence only), nearest first. */
async function nearbyRooms(loc) {
    const r = await api('/nearby', { method: 'POST', body: JSON.stringify({ from: loc.address, depth: 3, limit: 12, ...mapCtx() }) });
    return r.ok ? r.body.rooms : [];
}
// ---- Duplicate-room guard: a "new" place that closely matches a place within about 3 steps is that place.
const dupWords = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !['the', 'a', 'an', 'of'].includes(w)).map(w => w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
const edit1 = (a, b) => { // at most one insert, delete or substitution
    if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
};
/** Do two place names mean the same place? Same words (any order, "the"/plurals ignored), or one typo in one long word. */
export function closeName(a, b) {
    const x = dupWords(a), y = dupWords(b);
    if (!x.length || x.length !== y.length) return false;
    const xs = [...x].sort(), ys = [...y].sort();
    if (xs.join(' ') === ys.join(' ')) return true;
    const diff = x.map((w, i) => [w, y[i]]).filter(([u, v]) => u !== v);
    return diff.length === 1 && diff[0][0].length >= 5 && diff[0][1].length >= 5 && edit1(diff[0][0], diff[0][1]);
}
/** The nearest of `rooms` (from /nearby: {address, name, steps}) whose name closely matches `name`, within maxSteps; null if none. */
export function duplicatePlace(name, rooms, { maxSteps = 3, not = [] } = {}) {
    const hits = (rooms ?? []).filter(r => r?.name && !not.includes(r.address) && (r.steps ?? 0) <= maxSteps && closeName(name, r.name));
    return hits.sort((a, b) => (a.steps ?? 9) - (b.steps ?? 9))[0] ?? null;
}
/**
 * A change's create_place ops whose new room duplicates a nearby place become door pairs to that place instead
 * (one add_exit per exit of the new room; "new:<ref>" pointers to it then name the existing place).
 * Returns {ops, merged: [{name, to, to_name, steps}]}; ops unchanged when nothing matched.
 */
export function mergeDuplicates(ops, rooms, opts = {}) {
    const merged = [], refs = {};
    let out = [];
    for (const o of ops ?? []) {
        const dup = o?.op === 'create_place' && Array.isArray(o.exits) && o.exits.length ? duplicatePlace(o.name, rooms, opts) : null;
        if (!dup || o.exits.some(x => x.to === dup.address)) { out.push(o); continue; }
        merged.push({ name: o.name, to: dup.address, to_name: dup.name, steps: dup.steps });
        if (o.ref) refs[`new:${o.ref}`] = dup.address;
        for (const x of o.exits) out.push({ op: 'add_exit', loc: dup.address, to: x.to, direction: x.direction, return_direction: x.return_direction,
            ...(x.door != null ? { door: x.door } : {}), ...(x.travel_time ? { travel_time: x.travel_time } : {}), ...(x.description ? { description: x.description } : {}), ...(x.return_description ? { return_description: x.return_description } : {}) });
    }
    if (Object.keys(refs).length) out = JSON.parse(JSON.stringify(out), (k, v) => typeof v === 'string' && refs[v] ? refs[v] : v);
    return { ops: merged.length ? out : ops, merged };
}
export const NEW_PLACE = 'new';
/** The places a new opening can lead to: nearby rooms keyed by name (`new` is never a place key). */
export const digOptions = rooms => roomOptions(rooms, new Set([NEW_PLACE]));
export function digPrompt(loc, said, opts, used, canNew, err = '') {
    return P('dig.question', { party: partyText(), place: displayName(loc), description: loc.description ?? '', said,
        places: optionLines(opts) || '- (none)', new_place: canNew ? P('dig.new', { style: P('dig.style') }) + '\n' : '', used: used.join(', ') || 'none',
        retry: err ? P('dig.retry', { error: err }) + '\n' : '' });
}
const digWord = v => String(v ?? '').trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
const okWord = d => /^[a-z][a-z'-]*( [a-z][a-z'-]*)?$/.test(d) && d.length <= 20;
/**
 * Check one breaking-through JSON answer. Returns {ok:true, dest:{room}|{name, description}, direction, back, stay}
 * or {ok:false, error} (the error goes back to the model on the retry).
 */
export function readDigAnswer(a, { loc, opts, canNew, target = null }) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'the answer was not a JSON object' };
    let dest;
    if (a.existing != null && a.existing !== '') {
        const k = matchKey(String(a.existing), opts.map(o => o.key));
        if (k == null) return { ok: false, error: `"existing" must be one of the place keys: ${opts.map(o => o.key).join(', ') || '(none)'}` };
        dest = { room: opts.find(o => o.key === k).room };
    } else if (a.new && typeof a.new === 'object') {
        if (!canNew) return { ok: false, error: 'no new place can be made here: pick an "existing" place key' };
        const name = String(a.new.name ?? '').trim().replace(/\s+/g, ' '), description = String(a.new.description ?? '').trim().replace(/\s+/g, ' ');
        if (!/^[A-Za-z][A-Za-z' -]*$/.test(name) || name.split(' ').length > 5 || name.length > 40 || sameName(name, loc.name)) return { ok: false, error: '"new.name" must be a short new name (2-3 words, letters only)' };
        if (description.length < 10 || description.length > 300) return { ok: false, error: '"new.description" must be one short sentence' };
        dest = { name: name.replace(/\b[a-z]/g, c => c.toUpperCase()), description: /[.!?]$/.test(description) ? description : description + '.' };
    } else return { ok: false, error: canNew ? 'give "existing" (a place key) or "new" ({"name", "description"})' : 'give "existing" (a place key)' };
    const direction = digWord(a.direction);
    if (!okWord(direction)) return { ok: false, error: '"direction" must be a short exit name (1-2 words)' };
    if (hasExit(loc, direction)) return { ok: false, error: `there is already an exit "${direction}" here` };
    const back = digWord(a.return_direction) || returnName(direction);
    if (!okWord(back)) return { ok: false, error: '"return_direction" must be a short exit name (1-2 words)' };
    let backName = back;
    if (target && hasExit(target, backName)) { // e.g. "in" when the courtyard already has an "in": pick a free name instead of failing
        backName = [direction, `broken ${direction}`.slice(0, 20), 'hole', 'breach', 'gap'].find(n => okWord(n) && !hasExit(target, n));
        if (!backName) return { ok: false, error: `${roomLabel(target)} already has an exit "${back}"` };
    }
    const stay = matchKey(String(a.then ?? ''), ['stay', 'go_through']) === 'stay'; // biased toward moving: only a clear "stay" stays
    return { ok: true, dest, direction, back: backName, stay };
}
const nameRe = n => new RegExp(`(^|[^a-z])(?:the\\s+)?${String(n).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![a-z])`, 'i');
/** The nearby place the player's own words name ("...a passage to the courtyard"): the longest name, then the nearest. Null if none. */
export function namedPlace(text, opts) {
    const t = String(text ?? '');
    const hits = opts.filter(o => o.room?.name && nameRe(o.room.name).test(t));
    hits.sort((a, b) => b.room.name.length - a.room.name.length || (a.room.steps ?? 9) - (b.room.steps ?? 9));
    return hits[0] ?? null;
}
/** The exit word the player's text suggests for an opening they named a place for. */
export const digWordFrom = text => (String(text ?? '').match(/\b(window|hole|trapdoor|hatch|skylight|wall|floor|ceiling|crack|breach)\b/i)?.[1].toLowerCase() ?? 'opening');
/** Make the opening: an existing place gets the linked exit pair (a 'dig' change); a new one the shared create_place edit (a 'patch' change). */
async function makeDig(loc, r) {
    const desc = 'A freshly broken opening.';
    if (r.dest.room) {
        const b = await buildDig(loc, r.direction, { address: r.dest.room.address }, { returnDirection: r.back, description: desc, returnDescription: desc });
        return b.ok ? { ok: true, change: b.change, to: b.to, label: b.label } : { ok: false, error: b.error };
    }
    const pl = await loadPatchLib();
    if (!pl) return { ok: false, error: 'the map editor library is unavailable' };
    const op = pl.discoverToCreate({ loc: loc.address, name: r.dest.name, description: r.dest.description, direction: r.direction, return_direction: r.back, door: false, exit_description: desc, return_description: desc, travel_time: '10s' });
    const p = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: [op] }, ...mapCtx() }) });
    if (!p.ok) return { ok: false, error: p.body?.detail?.error ?? JSON.stringify(p.body?.detail ?? p.status) };
    const to = (p.body.touched ?? []).find(a => a.includes('/') && a !== loc.address);
    const change = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: `Broke through ${r.direction} to ${r.dest.name}`, at: chatElapsed(), ops: p.body.ops ?? [op] };
    return { ok: true, change, to, label: p.body.after?.[to]?.name ?? r.dest.name };
}
/**
 * The 'new opening' intent: ONE JSON question (where it leads: a nearby place or, where rooms may be added, a new one;
 * the exit names on both sides; stay or go through), retried once with the error. The change is stamped on the player's message.
 */
async function narrativeDig(msg, loc) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const fail = why => { console.log(`[WorldScrawl] dig failed: ${why}`); noteCall(ctx().chat?.indexOf(msg) ?? -1, { kind: 'breaking through', status: 'failed', reason: why }); msg.extra.worldscrawl_dig_failed = true; return { kind: 'dig_failed', loc }; };
    const opts = digOptions((await nearbyRooms(loc)).filter(r => r.address !== loc.address));
    const named = namedPlace(msg.mes, opts);
    if (named) { opts.splice(opts.indexOf(named), 1); opts.unshift(named); } // the place the player named comes first...
    const canNew = loc.expandable !== false && !named; // ...and is used: never a new place when the player named an existing one
    if (!opts.length && !canNew) return fail('nowhere to lead');
    const saidAll = named ? `${said}\nThe player names ${named.room.name}: the opening leads there (key "${named.key}").` : said;
    const used = loc.exits.filter(e => !e.hidden || e.revealed).map(e => e.direction); // never name a hidden exit in a prompt
    let err = '', made = null, r = null;
    for (let i = 0; i < DIG_TRIES && !made; i++) {
        const raw = await gen('discovery / dig', { prompt: digPrompt(loc, saidAll, opts, used, canNew, err), systemPrompt: digSys(), responseLength: 300 }, { retry: i > 0 });
        const a = parseJsonAnswer(raw);
        let pre = readDigAnswer(a, { loc, opts, canNew });
        const dupe = pre.ok && pre.dest.name ? opts.find(o => o.room && duplicatePlace(pre.dest.name, [o.room])) : null;
        if (dupe) { console.log(`[WorldScrawl] dig: "${pre.dest.name}" is ${dupe.room.name}, already on the map: linking it`); pre = readDigAnswer({ ...a, new: undefined, existing: dupe.key }, { loc, opts, canNew }); }
        const target = pre.ok && pre.dest.room ? await fetchLocationCached(pre.dest.room.address) : null;
        r = pre.ok && pre.dest.room ? (target ? readDigAnswer(a, { loc, opts, canNew, target }) : { ok: false, error: 'that place is unknown' }) : pre;
        if (r.ok) { const m = await makeDig(loc, r); if (m.ok) made = m; else r = { ok: false, error: m.error }; }
        console.log(`[WorldScrawl] dig (try ${i + 1}): ${JSON.stringify(String(raw).slice(0, 120))} -> ${r.ok ? JSON.stringify({ to: made.to, direction: r.direction, back: r.back, stay: r.stay }) : r.error}`);
        if (!made) { err = r.error; markLast(undefined, 'discovery / dig', 'failed', r.error); }
    }
    if (!made && named && !hasExit(loc, digWordFrom(msg.mes))) { // the model's answers didn't fit, but the player said where: link it directly
        const target = await fetchLocationCached(named.room.address);
        if (target) {
            const fb = readDigAnswer({ existing: named.key, direction: digWordFrom(msg.mes), then: 'go_through' }, { loc, opts, canNew: false, target });
            if (fb.ok) { const m = await makeDig(loc, fb); if (m.ok) { made = m; r = fb; console.log(`[WorldScrawl] dig: linked the named place ${named.room.address} directly`); } }
        }
    }
    if (!made) return fail(err);
    msg.extra[CHANGE_KEY] = made.change; // on the player's message, like a move: swipes keep it, deleting the message undoes it
    msg.extra.worldscrawl_dig = { direction: r.direction, back: r.back, to: made.to, to_name: made.label };
    if (r.stay) return { kind: 'dig', loc };
    const res = await engineMove(r.direction); // the change is already on this message, so /move gets it via chatChanges()
    if (!res.ok) { console.warn(`[WorldScrawl] dig: moving through ${r.direction} failed: ${res.error}`); return { kind: 'dig', loc }; }
    stamp(msg, res.to, res.move); // dig first, then location = destination (both roll back with this message)
    return { kind: 'move', loc: res.to };
}

export { askValid, gen, markLast, narrativeDig, nearbyRooms, noteCall };
