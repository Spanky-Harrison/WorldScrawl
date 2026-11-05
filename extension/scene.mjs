// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { messageActivity } from './activity.mjs';
import { noticeIdOf, newNoticeId, decisionOf, markDecided, unmarkDecided, once } from './notices.mjs';
import { render as P } from './shared.mjs';
import { PLAYER, positionOf } from './actors.mjs';
import { exportRecord, freeId, nameIn, normName, resolveSchedulePlace } from './shared.mjs';
import { NPC_KEY, FOUND_KEY, SUGGEST_AFTER, declinesInScene, focusRules, framesOf, absentAt, npcAt, npcPlayState, npcSlices, npcWhy, narratorView, unsavedPeople, whoAt, presentAt, readBack, readRememberAnswer, recordDiff, npcTiers, askedLoreNames, npcForName, nameStampFor, judgeFound, offMapReport, scheduleAt, sightCheck, flaggedPeople, sceneStartOf, renderNpcTokens, loreFor, addLoreRequest, activeLore, loreRequests, lastsMinutes, comingsAndGoings, parseRelArg } from './npc.mjs';
import { LOOK_AROUND_RE, arrivalReminder, factsText } from './brackets.mjs';
import { parseJsonAnswer } from './carriers.mjs';
import { calendarLib, chatElapsed, clockAt, defaultWorldId, gameDate, loadCalendar, placeWeatherNow, rememberWorlds, worldCasts, worldTimes } from './clock.mjs';
import { askValid, baseReply, gen, markLast } from './dig.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { api, currentLocation, doorOverrides, ensurePrompts } from './doors.mjs';
import { aftermathNote, chatKey, relocationNote } from './expiry.mjs';
import { FACTS_KEY, MOVE_KEY, PATCH_KEY, REMINDER_KEY, activeWorld, broadcastMapState, ctx, expiryPending, isOn, toolsOn } from './index.js';
import { displayName, lastUserIndex, optionLines, partyText, pickKey, stamp } from './movement.mjs';
import { mapCtx, patchSig, swipeOf } from './patches.mjs';
import { renderPatchCards, waitFacts } from './waits.mjs';

/** {{npc:id}} -> the cast name (before ST macros run); an unknown id shows as the bare id, with a console warning. */
export function renderTokens(text) {
    const pack = castPack();
    return renderNpcTokens(text, pack?.npcs ?? [], id => console.warn(`[WorldScrawl] {{npc:${id}}}: no cast NPC has that id; shown as "${id || 'someone'}".`));
}
/** Where the player stood at message i (for lore scenes; works without a cast). */
function lorePlayerAt(chat, loc) {
    const end = Math.max(0, (chat?.length ?? 1) - 1);
    return i => (i >= end && loc?.address ? loc.address : (positionOf(chat, Math.min(Math.max(i, 0), end), PLAYER)?.address || loc?.address || ''));
}
/** The lore chain entries fed this turn (asked for by flag or [lore] in this scene, at this place). */
export function fedLore(loc, extra = []) {
    const chat = ctx().chat ?? [];
    try { return activeLore(chat, chat.length - 1, loreChain(loc), lorePlayerAt(chat, loc), extra); } catch (e) { console.warn('[WorldScrawl] lore', e.message); return []; }
}
/** The lore index line and the fed-lore block for factsText. */
export function loreBits(loc, toolsOn) {
    const chain = loreChain(loc);
    if (!chain.length) return {};
    const fed = fedLore(loc);
    return {
        lore_index: P('narration.lore_index', { lore_places: chain.map(c => c.name).join(', '), how: P(toolsOn ? 'narration.lore_how_tools' : 'narration.lore_how_tags') }),
        lore_fed: fed.length ? P('narration.lore_block', { lore: fed.map(c => `- ${c.name}: ${c.text}`).join('\n') }) : '',
    };
}
/** Stamp a lore request for `place` (a name, or ''/"here" for all) on msg. Returns the matched chain entries. */
function requestLore(msg, loc, place, source) {
    let hits = loreFor(loreChain(loc), place);
    if (!hits.length) {
        const stub = matchStubLore(place);
        if (stub) hits = [{ level: 'elsewhere', id: stub.id, name: stub.name, text: stub.lore }];
    }
    if (hits.length) for (const h of hits) addLoreRequest(msg, { place: h.name, level: h.level, address: h.level === 'elsewhere' ? (h.id ?? '') : (loc?.address ?? ''), source });
    else addLoreRequest(msg, { place, level: '', address: loc?.address ?? '', source });
    return hits;
}

const REMEMBER_KEY = 'worldscrawl_remember';
const FOCUS_KEY = 'worldscrawl_focus';
let pendingNpc = []; // ws_npc tool calls, stamped on the reply
function baseCastPack() {
    const id = activeWorld || defaultWorldId;
    return (id && worldCasts.get(id)) || (defaultWorldId && worldCasts.get(defaultWorldId)) || null;
}
// The one live-map lookup for every NPC-side check (found, follow/stay, near, sightings, people here): the world's
// places plus the rooms this chat's map changes made, minus removed/moved ones. Refreshed from the server whenever
// the chat's active patches change (refreshLivePlaces); until then, and with no patches, the world's own places.
let livePlaces = null; // { key, pack }
const liveKey = () => `${activeWorld || defaultWorldId}\u0000${patchSig()}`;
export async function refreshLivePlaces() {
    try {
        const base = baseCastPack(); if (!base) { livePlaces = null; return; }
        const key = liveKey();
        if (!patchSig()) { livePlaces = null; return; }
        if (livePlaces?.key === key) return;
        const w = await api(`/cast/places?world=${encodeURIComponent(activeWorld || defaultWorldId)}`, { method: 'POST', body: JSON.stringify(mapCtx()) });
        livePlaces = { key, pack: { ...base, places: new Set(w.places ?? []), subs: new Set(w.subs ?? []), regions: new Set(w.regions ?? []), elsewhere: w.elsewhere ?? base.elsewhere, names: w.place_names ?? base.names, labels: { ...base.labels, ...(w.place_labels ?? {}) } } };
    } catch (e) { console.warn('[WorldScrawl] live places', e.message); }
}
function castPack() {
    const base = baseCastPack();
    return base && livePlaces && livePlaces.key === liveKey() ? livePlaces.pack : base;
}
function chatRelocate(chat) {
    const out = {};
    for (const m of chat ?? []) for (const p of m?.extra?.[PATCH_KEY] ?? []) {
        if (!p || p.off === true) continue;
        for (const [k, v] of Object.entries(p.relocate ?? {})) out[k] = v;
    }
    return out;
}
function npcClock(chat, i) {
    return clockOf(clockAt(Math.max(0, i), chat));
}
/** The game clock at `elapsed` seconds: {day, hour, minute, minutes, elapsed}. */
function clockOf(elapsed) {
    const t = worldTimes.get(activeWorld || defaultWorldId);
    if (!calendarLib || !t) return { day: 0, hour: 8, minute: 0, minutes: 8 * 60, elapsed };
    try {
        const d = calendarLib.dateAt(elapsed, t.start_date, t.calendar);
        return { day: d.day_number, hour: d.hour, minute: d.minute, minutes: d.hour * 60 + d.minute, elapsed };
    } catch { return { day: 0, hour: 8, minute: 0, minutes: 8 * 60, elapsed }; }
}
function npcEnv(chat, loc) {
    const pack = castPack();
    const relocate = chatRelocate(chat);
    const addresses = pack?.places ?? new Set();
    const end = Math.max(0, (chat?.length ?? 1) - 1);
    const exists = a => !!a && addresses.has(a) && !Object.prototype.hasOwnProperty.call(relocate, a);
    const rawAt = i => (i >= end && loc?.address ? loc.address : (positionOf(chat, Math.min(Math.max(i, 0), end), PLAYER)?.address || loc?.address || ''));
    return {
        exists, relocate,
        names: a => pack?.labels?.[a] || (loc?.address === a ? (loc.display_name || loc.name || a) : a),
        playerAt: i => { const raw = rawAt(i); const r = resolveSchedulePlace(raw, { exists, relocate }); return r.ok ? r.address : raw; },
        actorAt: (i, id) => positionOf(chat, Math.min(Math.max(i, 0), end), id)?.address || '',
        clock: i => npcClock(chat, Math.min(Math.max(i, 0), end)),
        timeAt: clockOf,
        pc: ctx().name1 || 'the player',
        index: pack ? {
            rooms: addresses, subs: pack.subs ?? new Set(), regions: pack.regions ?? new Set(),
            stubs: new Map((pack.elsewhere ?? []).map(s => [s.id, s])),
            nameOf: a => pack.labels?.[a] || a, exists, relocate,
        } : null,
    };
}
/** Stubs with lore the narrator may ask for: someone is off in them now, or a request this scene already named them. */
function loreChain(loc) {
    const base = [...(loc?.lore_chain ?? [])];
    const pack = castPack();
    const stubs = (pack?.elsewhere ?? []).filter(s => s.lore && !s.shadowed);
    if (!stubs.length) return base;
    const chat = ctx().chat ?? [];
    const want = new Set();
    try {
        const env = npcEnv(chat, loc);
        const end = Math.max(0, chat.length - 1);
        const last = framesOf(chat, end, pack.npcs ?? []).at(-1);
        if (last && chat.length) for (const n of last.values()) {
            const sched = scheduleAt(n, env.clock(end), env);
            if (sched?.near?.kind === 'stub') want.add(sched.near.id);
        }
    } catch { /* no clock yet */ }
    for (const r of loreRequests(chat)) if (r.level === 'elsewhere' && r.address) want.add(r.address);
    for (const s of stubs) if (want.has(s.id)) base.push({ level: 'elsewhere', id: s.id, name: s.name, text: s.lore });
    return base;
}
function matchStubLore(place) {
    const key = normName(place);
    if (!key) return null;
    return (castPack()?.elsewhere ?? []).find(s => !s.shadowed && s.lore && (normName(s.name) === key || s.id === key.replace(/ /g, '_') || nameIn(place, s.name))) ?? null;
}
function addNpcStamp(msg, stamp) {
    msg.extra = msg.extra ?? {};
    msg.extra[NPC_KEY] = [...(Array.isArray(msg.extra[NPC_KEY]) ? msg.extra[NPC_KEY] : []), { ...stamp, swipe: swipeOf(msg) }];
}
/** [name] /ws-name: the same npc_name stamp the narrator's name flag writes, with source bracket. */
async function learnNameOn(msg, name) {
    const who = String(name ?? '').trim();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_bracket = { verb: 'name', target: who };
    if (!who) { msg.extra.worldscrawl_bracket.status = 'rejected'; msg.extra.worldscrawl_bracket.reason = '[name] needs a name.'; return { ok: false, reason: '[name] needs a name.' }; }
    const chat = ctx().chat ?? [];
    const id = Math.max(0, chat.indexOf(msg));
    const folded = [...(framesOf(chat, id, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const r = nameStampFor(folded.length ? folded : (castPack()?.npcs ?? []), who, { source: 'bracket' });
    if (!r.ok) { msg.extra.worldscrawl_bracket.status = 'rejected'; msg.extra.worldscrawl_bracket.reason = r.reason; return r; }
    msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => !(s?.type === 'npc_name' && s.source === 'bracket' && (s.swipe ?? 0) === swipeOf(msg) && s.id === r.id));
    addNpcStamp(msg, r.stamp);
    msg.extra.worldscrawl_bracket.status = 'ok';
    syncSwipeExtra(msg);
    await ctx().saveChat?.();
    return r;
}
/** /ws-know <name> | unmet|met|named: the player sets what the PC and this person know of each other (the only way back). */
async function setRelOn(msg, arg) {
    const { name, state } = parseRelArg(arg);
    if (!name || !state) return { ok: false, reason: 'Say who and how well, e.g. /ws-know Hesk | met (unmet, met or named).' };
    const chat = ctx().chat ?? [];
    const id = Math.max(0, chat.indexOf(msg));
    const folded = [...(framesOf(chat, id, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const n = npcForName(folded, name) ?? folded.find(x => x.id === name);
    if (!n) return { ok: false, reason: `No saved person is called ${name}.` };
    addNpcStamp(msg, { type: 'npc_rel', id: n.id, who: PLAYER, state });
    syncSwipeExtra(msg);
    await ctx().saveChat?.();
    return { ok: true, name: n.name, state };
}
/** Judge a found name against the room the party is in right now (for the tool's answer, before the reply is stamped). */
async function judgeFoundNow(name) {
    const loc = await currentLocation();
    const chat = ctx().chat ?? [];
    const env = npcEnv(chat, loc);
    const end = Math.max(0, chat.length - 1);
    const folded = [...(framesOf(chat, end, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const n = npcForName(folded, name);
    if (!n) return { ok: false, reason: `No saved person is called "${name}".` };
    return judgeFound(n, env.clock(end), env.playerAt(end), env);
}
/**
 * [found] / [ws_flag: found | Name]: put them in the current room when that room is within the placeless entry's near.
 * The stamp is keyed by the entry's where label. Accepted and rejected both stay on the message, so the notice and the activity log can say why.
 */
async function applyFound(msg, names, source) {
    const list = [...new Set((names ?? []).map(n => String(n ?? '').trim()).filter(Boolean))];
    if (!list.length) return [];
    const c = ctx();
    const chat = c.chat ?? [];
    const at = Math.max(0, chat.indexOf(msg));
    const loc = await currentLocation();
    const env = npcEnv(chat, loc);
    const folded = [...(framesOf(chat, at, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const swipe = swipeOf(msg);
    msg.extra = msg.extra ?? {};
    msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => !(s?.type === 'npc_found' && (s.swipe ?? 0) === swipe && s.source === source));
    const prev = (msg.extra[FOUND_KEY] ?? []).filter(f => (f?.swipe ?? 0) !== swipe || f.source !== source);
    const decisions = [];
    for (const nm of list) {
        const n = npcForName(folded, nm);
        if (!n) { decisions.push({ swipe, name: nm, id: '', ok: false, reason: `No saved person is called "${nm}".`, source, where: '', place: '' }); continue; }
        const j = judgeFound(n, env.clock(at), env.playerAt(at), env);
        decisions.push({ swipe, name: n.name, id: n.id, ok: !!j.ok, reason: j.reason, source, where: j.where ?? '', place: j.place ?? '' });
        if (j.ok) addNpcStamp(msg, { type: 'npc_found', id: n.id, where: j.where ?? '', place: j.place, source });
    }
    msg.extra[FOUND_KEY] = [...prev, ...decisions];
    if (source === 'bracket') msg.extra.worldscrawl_bracket = { verb: 'found', target: list.join(', '), status: decisions.every(d => d.ok) ? 'ok' : 'rejected', reason: decisions.map(d => d.reason).join(' ') };
    syncSwipeExtra(msg);
    await c.saveChat?.();
    try { broadcastMapState(); } catch { /* map window may not be open */ }
    return decisions;
}
/** People-here text for the narrator. Empty when nobody saved is in the scene, so turns without them stay as they were. */
function npcPromptBits(loc) {
    const pack = castPack();
    const chat = ctx().chat ?? [];
    if (!pack?.npcs?.length || !chat.length || !calendarLib) return {};
    try {
        const env = npcEnv(chat, loc);
        const present = presentAt(chat, chat.length - 1, pack.npcs, env);
        const lore = fedLore(loc).map(c => c.text).join('\n'); // absence lines only for {{npc:id}} in lore being fed
        const absent = absentAt(chat, chat.length - 1, pack.npcs, env, { lore, present });
        const comings = comingsAndGoings(chat, chat.length - 1, pack.npcs, env);
        if (comings.length) absent.unshift(P('narration.npc_comings', { lines: comings.join('\n') }));
        if (!present.length && !absent.length) return {};
        if (absent.some(l => /, somewhere off the map/.test(l))) absent.push(P('narration.offmap_found'));
        if (!present.length) return { npcs_present: `(none)\n${absent.join('\n')}`, npc_focus: '' };
        const ui = lastUserIndex(chat);
        const stored = ui >= 0 ? chat[ui]?.extra?.[FOCUS_KEY] : null;
        const said = ui >= 0 ? chat[ui]?.mes ?? '' : '';
        const focus = stored && stored.depth ? stored : focusRules(said, present);
        const asked = askedLoreNames(chat, chat.length - 1, i => env.playerAt(i));
        const sl = npcSlices(present, focus, { tiers: npcTiers(present, focus, { chat, index: chat.length - 1, said, asked }), pc: env.pc });
        return { ...sl, ...(absent.length ? { npcs_present: `${sl.npcs_present}\n${absent.join('\n')}` } : {}) };
    } catch (e) { console.warn('[WorldScrawl] npcs', e.message); return {}; }
}
const DRAMATIC_RE = /\b(attacks?|stab(?:s|bed)?|rescues?|sav(?:e|es|ed)|kills?)\b/i;
const DISPO_OPTS = [
    { key: 'indifferent', label: 'the usual answer; no reason to feel strongly either way' },
    { key: 'unfriendly', label: 'cold, short or suspicious' },
    { key: 'friendly', label: 'warm, glad to see them' },
    { key: 'helpful', label: 'goes out of their way to help' },
    { key: 'hostile', label: 'wants to harm them' },
];
async function askDisposition(person, said) {
    await ensurePrompts();
    const prompt = P('npc.disposition', { name: person.name, line: person.line, party: partyText(), said: String(said ?? '').slice(0, 800), options: optionLines(DISPO_OPTS) });
    const hit = await askValid('disposition', prompt, pickKey(DISPO_OPTS));
    return hit?.key ?? 'indifferent';
}
async function askWho(loc, said, present) {
    await ensurePrompts();
    const opts = [...present.map(p => ({ key: p.id, label: p.name })), { key: 'nobody', label: 'nobody in particular' }];
    const prompt = P('npc.who', { party: partyText(), place: displayName(loc), said: String(said ?? '').slice(0, 800), options: optionLines(opts) });
    const hit = await askValid('who', prompt, pickKey(opts));
    return hit?.key && hit.key !== 'nobody' ? hit.key : null;
}
/** Before the narrator speaks: sighting stamps, a first attitude, and who is in focus. One pick-one, one retry, then indifferent. */
async function prepareNpcs(userMsg) {
    const pack = castPack();
    const chat = ctx().chat ?? [];
    if (!pack?.npcs?.length || !userMsg || !chat.length) return;
    if (userMsg.extra?.worldscrawl_npc_ready) return;
    userMsg.extra = userMsg.extra ?? {};
    userMsg.extra.worldscrawl_npc_ready = true;
    await loadCalendar();
    const loc = await currentLocation().catch(() => null);
    if (!loc || !calendarLib) return;
    const env = npcEnv(chat, loc);
    const index = chat.length - 1;
    const clock = env.clock(index);
    const here = env.playerAt(index);
    const frame = framesOf(chat, index, pack.npcs);
    const now = frame[frame.length - 1];
    const said = userMsg.mes ?? '';
    const seeking = /\b(find|seek|where is|look for|ask after|ask about)\b/i.test(said);
    if (now) for (const n of now.values()) {
        const oneOff = n.seen_at && !(n.schedule ?? []).some(e => !e.broken);
        if (seeking && oneOff && (nameIn(said, n.name) || nameIn(said, n.id)) && !n.seeks.some(s => s.day === clock.day)) addNpcStamp(userMsg, { type: 'npc_seek', id: n.id, day: clock.day });
        const check = sightCheck(n, clock, here, env, { appearances: n.appearances, seeks: n.seeks, useRoll: true });
        if (check.present && check.needsStamp) addNpcStamp(userMsg, { type: 'npc_appear', id: n.id, place: check.place, day: clock.day, hour: clock.hour });
    }
    let present = presentAt(chat, index, pack.npcs, env);
    for (const p of present) {
        if (p.disposition?.player?.value !== 'unknown' || (p.fromCast ?? []).includes(PLAYER)) continue;
        const value = await askDisposition(p, said);
        addNpcStamp(userMsg, { type: 'npc_disposition', id: p.id, who: PLAYER, value, reason: value === 'indifferent' ? 'No strong impression.' : '', ...(DRAMATIC_RE.test(said) ? { dramatic: true } : {}) });
    }
    present = presentAt(chat, index, pack.npcs, env);
    const rules = focusRules(said, present);
    let focus = rules;
    if (rules.ambiguous && present.length) {
        const id = await askWho(loc, said, present);
        focus = { id, depth: id ? (rules.depth === 'deep' ? 'deep' : 'focused') : 'present', ambiguous: false };
    }
    userMsg.extra[FOCUS_KEY] = { id: focus.id ?? null, depth: focus.depth ?? 'present', swipe: swipeOf(userMsg) };
}
function knownNpcNames(chat) {
    const pack = castPack();
    const names = [...(pack?.names ?? []), ...(pack?.npcs ?? []).flatMap(n => [n.name, n.id])];
    const frames = framesOf(chat, chat.length - 1, pack?.npcs ?? []);
    const end = frames[frames.length - 1];
    if (end) for (const n of end.values()) names.push(n.name, n.id);
    return names;
}
async function offerRemember(msg, name) {
    const chat = ctx().chat ?? [];
    let who = String(name ?? '').trim();
    if (!who) who = flaggedInScene(chat, chat.length - 1)[0]?.name ?? ''; // bare [remember]: the most recently flagged unsaved person
    if (!who) { toastr.info('WorldScrawl: say who to remember, e.g. /ws-npc Maren'); return; }
    const known = knownNpcNames(chat);
    if (known.some(n => normName(n) === normName(who) || nameIn(who, n))) { toastr.info(`WorldScrawl: ${who} is already remembered.`); return; }
    msg.extra = msg.extra ?? {};
    msg.extra[REMEMBER_KEY] = { swipe: swipeOf(msg), name: who, status: 'review', nid: newNoticeId('remember') };
    await ctx().saveChat?.();
    renderPatchCards();
}
async function keepRemember(id, edited = null) {
    const c = ctx(), msg = c.chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return;
    const nid = noticeIdOf(card, 'remember');
    return once(nid, async () => {
        if (!markDecided(msg, nid, edited ? 'adjust' : 'approve', { swipe: swipeOf(msg), text: `remember ${edited?.name?.trim() || card.name}` })) return; // decided once: a second Approve is a no-op
        try { await keepRememberNow(c, msg, card, id, edited); } catch (e) { unmarkDecided(msg, nid); renderPatchCards(); throw e; }
    });
}
const REMEMBER_BLANK = { manner: '', voice: '', looks: '', body: '', outfit: '', history: '', unknownAs: '', facts: [], invented: [] };
/** The remember model call for `name` at message `id`: a parsed card, or null after two unusable answers. */
async function askRemember(id, name, { prefetch = false } = {}) {
    const chat = ctx().chat ?? [];
    const [, loc] = await Promise.all([ensurePrompts(), currentLocation().catch(() => null)]);
    const back = readBack(chat.slice(0, id + 1).filter(m => !m.is_system).map((m, i) => ({ text: m.mes ?? '', index: i })), name);
    const story = back.messages.map(m => m.text).join('\n').slice(0, 6000);
    const prompt = P('npc.remember', { name, place: loc ? displayName(loc) : 'here', story: story || '(nothing was said yet)' });
    const kind = prefetch ? 'remember (prefetch)' : 'remember';
    let got = null;
    for (let t = 0; t < 2 && !got; t++) {
        try { got = readRememberAnswer(parseJsonAnswer(await gen(kind, { prompt, systemPrompt: P('npc.remember_system', { reply: baseReply('json') }), responseLength: 900 }, { at: id, retry: t > 0 }))); } catch { got = null; }
        if (!got) markLast(id, kind, 'failed', 'answer was not a usable person');
    }
    return got;
}
// Prefetch: the remember call starts when the card first shows (once per card id). The answer is cached on the card
// (msg.extra, per swipe) so a redraw never calls again; Approve uses it, or awaits the call still in flight.
const rememberFlights = new Map(); // card nid -> promise of the parsed card (or null)
function prefetchRemember(id) {
    const msg = ctx().chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return null;
    card.nid = card.nid || newNoticeId('remember');
    if (card.proposal?.name === card.name && card.proposal.got) return Promise.resolve(card.proposal.got);
    if (rememberFlights.has(card.nid)) return rememberFlights.get(card.nid);
    if (card.proposal?.failed && card.proposal.name === card.name) return null; // failed: wait for Retry
    const name = card.name;
    const p = askRemember(id, name, { prefetch: true }).catch(() => null).then(got => {
        card.proposal = got ? { name, got } : { name, failed: true };
        syncSwipeExtra(msg);
        ctx().saveChat?.();
        renderPatchCards();
        return got;
    }).finally(() => rememberFlights.delete(card.nid));
    rememberFlights.set(card.nid, p);
    return p;
}
function retryRemember(id) {
    const card = ctx().chat?.[id]?.extra?.[REMEMBER_KEY];
    if (card?.proposal?.failed) delete card.proposal;
    prefetchRemember(id);
    renderPatchCards();
}
async function keepRememberNow(c, msg, card, id, edited) {
    const chat = c.chat ?? [];
    const name = edited?.name?.trim() || card.name;
    const blank = REMEMBER_BLANK;
    let got = edited?.line ? { ...blank, name, line: edited.line.trim() } : null;
    if (!got && name === card.name) {
        if (card.proposal?.name === name && card.proposal.got) got = card.proposal.got; // prefetched: instant
        else if (rememberFlights.has(card.nid)) got = await rememberFlights.get(card.nid); // in flight: never a second call
    }
    if (!got) got = await askRemember(id, name);
    if (!got) got = { ...blank, name, line: 'Met in this scene.' };
    else if (edited?.name?.trim() && name !== got.name) got = { ...got, name };
    const taken = new Set(knownNpcNames(chat));
    const newId = freeId(got.name, taken);
    addNpcStamp(msg, { type: 'npc_create', id: newId, name: got.name, line: got.line, manner: got.manner, voice: got.voice,
        ...Object.fromEntries(['looks', 'body', 'outfit', 'history', 'unknownAs'].filter(k => got[k]).map(k => [k, got[k]])), facts: got.facts, ...(got.invented?.length ? { invented: got.invented } : {}) });
    if (got.disposition) addNpcStamp(msg, { type: 'npc_disposition', id: newId, who: PLAYER, value: got.disposition.value, reason: got.disposition.reason ?? '', dramatic: true });
    card.status = 'kept'; card.name = got.name;
    const d = decisionOf(msg, card.nid); if (d) d.text = `remembered ${got.name}`;
    syncSwipeExtra(msg);
    renderPatchCards(); // show the result at once; saving and the prompt refresh follow
    toastr.success(`WorldScrawl: ${got.name} remembered. Delete this message to undo it.`);
    await c.saveChat?.();
    await applyFacts();
    renderPatchCards();
}
async function discardRemember(id) {
    const c = ctx(), msg = c.chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return;
    if (!markDecided(msg, noticeIdOf(card, 'remember'), 'discard', { swipe: swipeOf(msg), text: `not remembering ${card.name} this scene` })) return;
    addNpcStamp(msg, { type: 'npc_decline', name: card.name });
    card.status = 'declined';
    syncSwipeExtra(msg);
    await c.saveChat?.();
    renderPatchCards();
}
/** Unsaved people the narrator flagged ([ws_flag: npc | Name]) in the scene holding message `id`, most recent first, with counts. */
export function flaggedInScene(chat, id) {
    if (id < 0 || !chat?.length) return [];
    const at = i => positionOf(chat, i, PLAYER)?.address || '';
    const declined = declinesInScene(chat, id, at);
    return flaggedPeople(chat, sceneStartOf(chat, id, at), id, { known: knownNpcNames(chat), declined: [...declined], threshold: SUGGEST_AFTER });
}
function maybeSuggest(id) {
    const chat = ctx().chat ?? [];
    const pack = castPack();
    const msg = chat[id];
    if (!pack || !msg || msg.extra?.[REMEMBER_KEY]) return;
    const known = knownNpcNames(chat);
    const hit = flaggedInScene(chat, id).find(s => s.ready && !chat.some(m => normName(m?.extra?.[REMEMBER_KEY]?.name ?? '') === s.key));
    if (!hit) return;
    msg.extra = msg.extra ?? {};
    msg.extra[REMEMBER_KEY] = { swipe: swipeOf(msg), name: hit.name, status: 'review', suggested: true, nid: newNoticeId('remember') };
}
async function exportNpc(id, { update = false } = {}) {
    const chat = ctx().chat ?? [];
    const pack = castPack();
    const npc = npcAt(chat, chat.length - 1, pack?.npcs ?? [], id);
    const record = npc ? exportRecord(npc) : null;
    if (!record) { toastr.warning('WorldScrawl: that person is not in this chat.'); return; }
    const r = await api('/cast/export', { method: 'POST', body: JSON.stringify({ npc: record, ...(update ? { update: true } : {}) }) });
    if (!r.ok) { const msg = typeof r.body?.detail === 'string' ? r.body.detail : 'Could not export.'; toastr.warning(msg); return { ok: false, error: msg }; }
    rememberWorlds((await api('/worlds').catch(() => null))?.body);
    const where = `cast/${r.body.file}`;
    toastr.success(r.body.updated ? `WorldScrawl: updated ${where}.` : `WorldScrawl: wrote ${where}${r.body.renamed ? ` (as ${r.body.id}, the old file was kept)` : ''}.`);
    broadcastMapState();
    return { ok: true, id: r.body.id, file: r.body.file, updated: !!r.body.updated };
}
/** The map's cast browser: every saved person in this chat, where they are, their stamps, and the Update diff against their cast file. */
function mapNpcs(chat, here) {
    const pack = castPack();
    if (!pack) return [];
    try {
        return npcPlayState(chat ?? [], pack.npcs ?? [], npcEnv(chat ?? [], here)).map(n => {
            const castNpc = (pack.npcs ?? []).find(x => x.ok && x.id === n.id) ?? null;
            const { record, ...rest } = n;
            return { ...rest, record, inCast: !!castNpc, diff: castNpc ? recordDiff(castNpc, n) : null };
        });
    } catch (e) { console.warn('[WorldScrawl] npc state for the map failed', e); return []; }
}
/** The per-message activity log for the map: the last 30 messages, newest first, with sighting rolls at each. */
function mapActivity(chat, here) {
    if (!chat?.length) return [];
    const c = ctx(), chatId = c.chatId ?? c.getCurrentChatId?.();
    const pack = castPack();
    let env = null, frames = null;
    try { env = npcEnv(chat, here); frames = framesOf(chat, chat.length - 1, pack?.npcs ?? []); } catch { /* no world */ }
    const out = [];
    for (let i = chat.length - 1; i >= 0 && out.length < 30; i--) {
        const m = chat[i]; if (!m) continue;
        const rolls = [];
        if (env && frames?.[i] && !m.is_user) for (const n of frames[i].values()) {
            if (!n.seen_at) continue;
            try { const w = npcWhy(n, i, env); const g = w.sighting; if (g?.active && g.roll != null) rolls.push({ kind: 'roll', label: `${n.name} sighting${g.sought ? ' (by name)' : ''}`, roll: g.used, chance: g.now, seekRoll: g.seekRoll, present: g.wouldShow }); } catch { /* skip */ }
        }
        out.push({ msg: i, who: m.is_user ? 'you' : m.is_system ? 'system' : m.name ?? 'narrator', snippet: String(m.mes ?? '').slice(0, 80), entries: messageActivity(m, i, { chatId, extra: rolls }) });
    }
    return out;
}
/** The map inspector: who is at each place that matters (with no-show reasons), what the narrator was told per reply, and unsaved people. */
function mapInspect(chat, here) {
    const pack = castPack();
    if (!pack || !chat?.length) return null;
    try {
        const env = npcEnv(chat, here);
        const end = chat.length - 1;
        const places = new Set([here?.address].filter(Boolean));
        for (const n of pack.npcs ?? []) { for (const e of n.schedule ?? []) if (e?.place) places.add(resolveSchedulePlace(e.place, env).address ?? e.place); if (n.seen_at?.place) places.add(resolveSchedulePlace(n.seen_at.place, env).address ?? n.seen_at.place); }
        const play = mapNpcs(chat, here);
        for (const n of play) if (n.position?.place) places.add(n.position.place);
        const who = {};
        for (const a of places) who[a] = whoAt(chat, end, pack.npcs ?? [], env, a);
        const narrator = [];
        for (let i = end; i > 0 && narrator.length < 15; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) { const v = narratorView(chat, i, pack.npcs ?? [], env, FOCUS_KEY); if (v) narrator.push(v); }
        const unsaved = unsavedPeople(chat, { known: knownNpcNames(chat), threshold: SUGGEST_AFTER, playerAt: i => env.playerAt(i) || '', rememberKey: REMEMBER_KEY });
        return { who, narrator, unsaved, threshold: SUGGEST_AFTER, offmap: offMapReport(play, pack.elsewhere ?? []) };
    } catch (e) { console.warn('[WorldScrawl] npc inspector failed', e); return null; }
}
/** "In this chat" edits from the map: stamps on the latest message, only if the chat, message and swipe are still the ones the map saw. */
const CHAT_EDIT_TYPES = new Set(['npc_fact', 'npc_memory', 'npc_disposition']);
async function npcChatEdit(d) {
    const c = ctx(), chat = c.chat ?? [];
    if (!d.chatId || d.chatId !== (c.chatId ?? c.getCurrentChatId?.())) return { ok: false, error: 'That chat is not open in SillyTavern any more.' };
    const i = Number(d.msg), msg = chat[i];
    if (!msg || i !== chat.length - 1) return { ok: false, error: 'The chat has moved on since the map loaded; check the In this chat view again.', stale: true };
    if ((d.swipe ?? null) !== (swipeOf(msg) ?? null)) return { ok: false, error: 'That message is on a different swipe now.', stale: true };
    const id = String(d.id ?? '');
    if (!npcAt(chat, i, castPack()?.npcs ?? [], id)) return { ok: false, error: 'That person is not in this chat.' };
    const stamps = (Array.isArray(d.stamps) ? d.stamps : []).filter(s => s && CHAT_EDIT_TYPES.has(s.type)).map(s => ({ ...s, id, by: 'map' }));
    if (!stamps.length) return { ok: false, error: 'Nothing changed.' };
    for (const s of stamps) addNpcStamp(msg, s);
    syncSwipeExtra(msg);
    await c.saveChat?.();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, count: stamps.length, msg: i };
}
function npcDetail(id) {
    const chat = ctx().chat ?? [];
    const npc = npcAt(chat, chat.length - 1, castPack()?.npcs ?? [], id);
    if (!npc) return 'No saved person with that id is here.';
    const bits = [`Personality: ${npc.line}`];
    if (npc.manner) bits.push(`Manner: ${npc.manner}`);
    if (npc.voice) bits.push(`Speech: ${npc.voice}`);
    if (npc.looks) bits.push(`Looks: ${npc.looks}`);
    if (npc.body) bits.push(`Body: ${npc.body}`);
    if (npc.outfit) bits.push(`Wearing: ${npc.outfit}`);
    if (npc.memory?.length) bits.push(`Memory: ${npc.memory.join('; ')}`);
    if (npc.deep?.history) bits.push(`History: ${npc.deep.history}`);
    if (npc.deep?.secrets?.length) bits.push(`Secrets: ${npc.deep.secrets.join('; ')}`);
    if (npc.deep?.relationships) bits.push(`Relationships: ${Object.entries(npc.deep.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    return bits.filter(Boolean).join('\n');
}
function toolNpcStamp(args = {}) {
    const action = String(args.action ?? '').toLowerCase();
    const id = String(args.id ?? '').trim();
    if (!id) return null;
    if (action === 'fact') { const lasts = lastsMinutes(args.lasts); return args.text ? { type: 'npc_fact', id, field: 'fact', text: String(args.text), ...(lasts ? { lasts } : {}) } : null; }
    if (action === 'memory') return args.text ? { type: 'npc_memory', id, note: String(args.text) } : null;
    if (action === 'disposition') return { type: 'npc_disposition', id, who: PLAYER, value: args.value, reason: String(args.reason ?? args.text ?? '') };
    if (action === 'leave') return { type: 'npc_leave', id };
    if (action === 'staying') return { type: 'npc_staying', id, elapsed: chatElapsed() };
    if (action === 'follow') return { type: 'npc_follow', id, who: PLAYER };
    if (action === 'stay') return { type: 'npc_stay', id };
    if (action === 'seek') return { type: 'npc_seek', id, day: npcClock(ctx().chat ?? [], (ctx().chat ?? []).length - 1).day };
    return null;
}

async function applyFacts() {
    await ensurePrompts();
    await refreshLivePlaces();
    const c = ctx();
    if (!isOn()) { c.setExtensionPrompt(FACTS_KEY, '', 1, 1, false, 0); c.setExtensionPrompt(REMINDER_KEY, '', 1, 0, false, 0); return; }
    let text = '', reminder = '';
    try {
        const loc = await currentLocation();
        const ui = lastUserIndex(c.chat ?? []);
        const move = ui >= 0 ? c.chat[ui].extra?.[MOVE_KEY] : null;
        const um = ui >= 0 ? c.chat[ui].extra ?? {} : {};
        await loadCalendar();
        const d = gameDate();
        text = factsText(loc, move, toolsOn(), { date: d ? calendarLib.describeDate(d) : '', weather: placeWeatherNow(loc)?.line ?? '', took: move?.seconds && calendarLib ? calendarLib.formatDuration(move.seconds) : '', dig: um.worldscrawl_dig, digFailed: um.worldscrawl_dig_failed, look: um.worldscrawl_look, newDoor: um.worldscrawl_new_door, lookAround: ui >= 0 && LOOK_AROUND_RE.test(c.chat[ui].mes ?? '') && !(um.worldscrawl_look && (um.worldscrawl_look.via || um.worldscrawl_look.window)), door: um.worldscrawl_door, open: doorOverrides(), ...loreBits(loc, toolsOn()), ...npcPromptBits(loc) });
        reminder = arrivalReminder(loc, move);
        const ep = expiryPending?.chat === chatKey() && expiryPending.to === loc.address ? expiryPending : null;
        if (ep) { ep.used = true; if (ep.line) text = `${text}\n${ep.line}`; }
        const rn = ep ? '' : relocationNote(c.chat ?? [], loc, partyText());
        if (rn) text = `${text}\n${rn}`;
        else if (!ep) { const am = await aftermathNote(c.chat ?? [], loc).catch(() => ''); if (am) text = `${text}\n${am}`; }
        const wf = await waitFacts(c.chat ?? [], loc);
        if (wf) text = `${text}\n${wf}`;
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    // Small models weigh the last lines most: on a move/travel turn, repeat where the turn ends after the player's message.
    c.setExtensionPrompt(REMINDER_KEY, reminder, 1 /* IN_CHAT */, 0, false, 0 /* SYSTEM */);
}

export { REMEMBER_KEY, setRelOn, addNpcStamp, applyFacts, applyFound, castPack, discardRemember, exportNpc, judgeFoundNow, keepRemember, learnNameOn, loreChain, mapActivity, mapInspect, mapNpcs, matchStubLore, maybeSuggest, npcChatEdit, npcClock, npcDetail, npcEnv, offerRemember, pendingNpc, prefetchRemember, prepareNpcs, requestLore, retryRemember, toolNpcStamp };
