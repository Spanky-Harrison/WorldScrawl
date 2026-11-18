// The daily pattern for a person being remembered (docs/npc-design.md, "Daily patterns"): one small JSON question,
// asked once the Remember card is ready, cached on the card (per swipe), shown on the card while it runs. The answer
// is checked against the places it was offered (plugin/shared/npc.mjs readSchedulePick); one retry with the error,
// then passing through. Approve expands the pick into the person's schedule (expandPattern) with no model call;
// Approve edited reads the typed Pattern / Job / Home / Favorites against the whole live map instead.
import { render as P, npc as Npc } from './shared.mjs';
import { baseReply, gen, markLast } from './dig.mjs';
import { parseJsonAnswer } from './carriers.mjs';
import { api, currentLocation, ensurePrompts } from './doors.mjs';
import { ctx } from './index.js';
import { mapCtx } from './patches.mjs';
import { maskForModel } from './names.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { renderPatchCards } from './waits.mjs';
import { REMEMBER_KEY, castPack, npcClock, npcEnv, rememberStory } from './scene.mjs';

/** How many rooms the question lists, nearest first (the met room first). */
export const PICK_ROOMS = 40;
const hhmm = m => `${String(Math.floor((m ?? 0) / 60) % 24).padStart(2, '0')}:${String((m ?? 0) % 60).padStart(2, '0')}`;

/** Where and when the card's person was met: the player's room at the card's message on the live map, and that minute of the day. */
export async function metAt(chat, id) {
    let room = '';
    try { room = npcEnv(chat, await currentLocation().catch(() => null)).playerAt(id) || ''; } catch { room = ''; }
    return { room, minutes: npcClock(chat, id).minutes ?? 0 };
}

/** The whole live map as a pick's place lists (the player's typed edit is read against this). */
export function livePlaceIndex() {
    const pack = castPack();
    const label = a => pack?.labels?.[a] || a, privs = pack?.privates ?? new Set();
    const rooms = new Map([...(pack?.places ?? [])].map(a => [a, { name: label(a), private: privs.has(a) }]));
    const areas = new Map([...(pack?.subs ?? []), ...(pack?.regions ?? [])].map(a => [a, label(a)]));
    const stubs = new Map((pack?.elsewhere ?? []).filter(s => s?.id && !s.shadowed).map(s => [s.id, s.name || s.id]));
    return { rooms, areas, stubs };
}
/** How a place shows in the editor boxes: its name when exactly one live room, area or stub has that name, else its key. */
export function placeLabel(a) {
    const idx = livePlaceIndex(), n = Npc.normName;
    const name = idx.rooms.get(a)?.name ?? idx.areas.get(a) ?? idx.stubs.get(a);
    if (!name) return a;
    const same = [...idx.rooms.values()].filter(r => n(r.name) === n(name)).length + [...idx.areas.values()].filter(x => n(x) === n(name)).length + [...idx.stubs.values()].filter(x => n(x) === n(name)).length;
    return same === 1 ? name : a;
}
/** A place's name for the card's summary line. */
export const placeName = a => livePlaceIndex().rooms.get(a)?.name ?? livePlaceIndex().areas.get(a) ?? livePlaceIndex().stubs.get(a) ?? a;

/**
 * The places the question offers: the met room, then the nearest rooms on the live map (up to PICK_ROOMS in all), the
 * areas holding them, and the places off the map. {rooms: Map(address -> {name, private, area}), areas, stubs}.
 */
export async function pickPlaces(room) {
    const live = livePlaceIndex();
    const rooms = new Map(), areas = new Map();
    const add = a => {
        if (!a || rooms.has(a) || rooms.size >= PICK_ROOMS || !live.rooms.has(a)) return;
        const area = Npc.areaOfRoom(a);
        rooms.set(a, { ...live.rooms.get(a), area: live.areas.get(area) ?? '' });
        // An area is offered only when it has a public room listed: a job or favorite area with none could never resolve.
        if (area && area !== a && live.areas.has(area) && !areas.has(area) && !live.rooms.get(a).private) areas.set(area, live.areas.get(area));
    };
    add(room);
    try {
        const r = await api('/nearby', { method: 'POST', body: JSON.stringify({ from: room, depth: 6, limit: PICK_ROOMS, ...mapCtx() }) });
        for (const x of (r?.ok ? r.body?.rooms : null) ?? []) add(x.address);
    } catch { /* the met room alone */ }
    return { rooms, areas, stubs: live.stubs };
}
/** The {{place_list}} lines: rooms ("- KEY: name (area) [private]"), then areas, then places off the map. */
export function placeList(places) {
    const lines = [...places.rooms].map(([a, r]) => `- ${a}: ${r.name}${r.area ? ` (${r.area})` : ''}${r.private ? ' [private]' : ''}`);
    if (places.areas.size) lines.push('Areas (anywhere public inside):', ...[...places.areas].map(([a, name]) => `- ${a}: ${name}`));
    if (places.stubs.size) lines.push('Off the map:', ...[...places.stubs].map(([a, name]) => `- ${a}: ${name}`));
    return lines.join('\n');
}

/**
 * The daily pattern question for the person on the Remember card at message `id`. {status: 'ok', pick, warnings, room,
 * minutes} | {status: 'failed', reason, room, minutes} (passing through) | {status: 'skipped'} (no room: no schedule).
 * Every outcome is noted on the message as kind `schedule`.
 */
export async function askSchedule(id, { name = '', got = null } = {}) {
    const chat = ctx().chat ?? [];
    const { room, minutes } = await metAt(chat, id);
    if (!room) return { status: 'skipped', reason: 'no room' };
    await ensurePrompts();
    const places = await pickPlaces(room);
    // The name portal masks the engine-built parts (the card's line and looks, the name); the story goes as it was written.
    const about = got?.line ? `${got.line}${got.looks ? ` Looks: ${got.looks}` : ''}` : '(Their card is not written yet.)';
    const prompt = P('npc.schedule_pick', { name: maskForModel(got?.name || name), place: placeName(room), time: hhmm(minutes), about: maskForModel(about), story: rememberStory(chat, id, got?.name || name) || '(nothing was said yet)', place_list: placeList(places) });
    const systemPrompt = P('npc.schedule_pick_system', { reply: baseReply('json') });
    let error = 'no answer';
    for (let t = 0; t < 2; t++) {
        let raw;
        try { raw = await gen('schedule', { prompt: t ? `${prompt}\n\n${P('npc.schedule_pick_retry', { error })}` : prompt, systemPrompt, responseLength: 300 }, { at: id, shown: 'card', retry: t > 0 }); } catch (e) { error = e?.message || 'the call failed'; continue; }
        const ans = parseJsonAnswer(raw);
        const r = ans ? Npc.readSchedulePick(ans, places) : { error: 'the answer is not a JSON object' };
        if (r.pick) {
            if (r.warnings.length) markLast(id, 'schedule', 'ok', r.warnings.join('; '));
            return { status: 'ok', pick: r.pick, warnings: r.warnings, room, minutes };
        }
        error = r.error;
        markLast(id, 'schedule', 'failed', error);
    }
    markLast(id, 'schedule', 'failed', `${error}; passing through instead`);
    return { status: 'failed', reason: error, room, minutes };
}

// The question runs once per card (its notice id): cached on the card, so a redraw never asks again; Approve uses the
// answer, or waits for the call in flight. Check again (the card's "Check schedule again") asks only this question again.
const flights = new Map(); // card nid -> promise of the result
const cardAt = id => ctx().chat?.[id]?.extra?.[REMEMBER_KEY] ?? null;
/** Start (or join) the pattern question for the Remember card at `id`. Null when there is no card in review. */
export function prefetchSchedule(id) {
    const msg = ctx().chat?.[id], card = cardAt(id);
    if (!card || card.status !== 'review' || !card.nid) return null;
    if (card.schedule?.status) return Promise.resolve(card.schedule);
    if (flights.has(card.nid)) return flights.get(card.nid);
    const sgen = card.sgen ?? 0, got = card.proposal?.got ?? null;
    const p = askSchedule(id, { name: got?.name || card.name, got }).catch(e => ({ status: 'failed', reason: e?.message || 'the call failed' })).then(res => {
        if ((card.sgen ?? 0) !== sgen) return res; // a newer Check again replaced this call
        card.schedule = res;
        syncSwipeExtra(msg);
        ctx().saveChat?.();
        renderPatchCards();
        return res;
    }).finally(() => { if (flights.get(card.nid) === p) flights.delete(card.nid); });
    flights.set(card.nid, p);
    renderPatchCards();
    return p;
}
/** The pattern question in flight for this card, if any. */
export const scheduleFlight = card => (card?.nid ? flights.get(card.nid) ?? null : null);
/** Check schedule again: drop the cached answer and ask again. */
export function retrySchedule(id) {
    const card = cardAt(id);
    if (!card || card.status !== 'review') return null;
    card.sgen = (card.sgen ?? 0) + 1;
    delete card.schedule;
    if (card.nid) flights.delete(card.nid);
    scheduleErrors.delete(`${id}|remember`);
    return prefetchSchedule(id);
}

/** A typed edit's problem, shown on its card until the next try (card key -> text). */
export const scheduleErrors = new Map();
/** A typed edit's warning (it still saves), shown on its card and as a toast (card key -> text). */
export const scheduleWarnings = new Map();
/** The typed Pattern / Job / Home / Favorites over `pick` (changed boxes only), read strictly against the live map: {pick, warnings} or {error}. */
export function scheduleWith(pick, values = {}, changed = []) {
    const r = Npc.readSchedulePick(Npc.pickFromValues(pick, values, changed), livePlaceIndex(), { strict: true });
    return r.error ? { error: `Schedule: ${r.error}.` } : { pick: r.pick, warnings: r.warnings };
}
/** The editor boxes for a pick. */
export function scheduleFields(pick) {
    const v = Npc.pickValues(pick, placeLabel);
    return Npc.SCHEDULE_FIELDS.map(([key, label, placeholder]) => ({ key, label, value: v[key] ?? '', kind: 'text', cls: `worldscrawl_${key}`, placeholder }));
}
/** The card's schedule line: {phase ('working'|'ok'|'failed'), text, reason} or null (no room: no schedule). */
export function scheduleView(card) {
    const s = card?.schedule;
    if (!s?.status) return scheduleFlight(card) ? { phase: 'working', text: 'Working out a schedule…' } : null;
    if (s.status === 'skipped') return null;
    if (s.status === 'failed') return { phase: 'failed', text: "Couldn't decide, so passing through", reason: s.reason ?? '' };
    return { phase: 'ok', text: Npc.pickSummary(s.pick, { nameOf: placeName, room: s.room, minutes: s.minutes }) };
}
