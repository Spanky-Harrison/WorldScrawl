import { appearanceScope } from './npceffects.mjs';
// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { messageActivity } from './activity.mjs';
import { noticeIdOf, newNoticeId, decisionOf, markDecided, unmarkDecided, once } from './notices.mjs';
import { render as P, cards as C, npc as Npc } from './shared.mjs';
import { PLAYER, positionOf } from './actors.mjs';
import { authorRecord, freeId, nameIn, normName, resolveSchedulePlace } from './shared.mjs';
import { NPC_KEY, FOUND_KEY, SUGGEST_AFTER, declinesInScene, focusRules, framesOf, absentAt, npcAt, npcPlayState, npcSlices, npcWhy, narratorView, unsavedPeople, whoAt, presentAt, readBack, readRememberAnswer, fileDiff, npcTiers, askedLoreNames,  judgeFound, offMapReport, scheduleAt, sightCheck, flaggedPeople, sceneStartOf, loreFor, addLoreRequest, activeLore, loreRequests, lastsMinutes, comingsAndGoings, parseRelArg, alreadyShown, alreadyEffect, effectFields, effectSetKey, resolveAppearance, rebuildInputs, planAppearanceRebuild, acceptAppearanceRebuild, classifyAppearanceReply, planLooksSummary, acceptLooksSummary } from './npc.mjs';
import { bumpEpoch, decideNpc, epochOf as ownerEpoch, fillCandidate, makeOwner, recompose, reviewTyped } from './owners.mjs';
import { NPC_EXPIRED_KIND, describeExpiries, expiryKey, expiryNarratorNote, expiryNoticeText, expiryWindow, noticedExpiries, personExpiriesBetween } from './npcexpiry.mjs';
import { messageKey } from './replay.mjs';
import { capFirst, configureNames, findPerson, handleOf, judgeLearn, maskForModel, maskText, nameLeaks, shownName } from './names.mjs';
import { LOOK_AROUND_RE, arrivalReminder, factsText } from './brackets.mjs';
import { parseJsonAnswer } from './carriers.mjs';
import { calendarLib, chatElapsed, clockAt, defaultWorldId, gameDate, loadCalendar, placeWeatherNow, rememberWorlds, worldCasts, worldTimes } from './clock.mjs';
import { askValid, baseReply, gen, markLast, noteCall } from './dig.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { api, currentLocation, doorOverrides, ensurePrompts } from './doors.mjs';
import { aftermathNote, chatKey, relocationNote } from './expiry.mjs';
import { FACTS_KEY, MOVE_KEY, PATCH_KEY, REMINDER_KEY, activeWorld, broadcastMapState, ctx, expiryPending, isOn, revealNamesOn, toolsOn } from './index.js';
import { displayName, lastUserIndex, optionLines, partyText, pickKey, stamp } from './movement.mjs';
import { mapCtx, patchSig, swipeOf } from './patches.mjs';
import { renderPatchCards, waitFacts } from './waits.mjs';

/** Everyone in the cast as they are at the end of the chat (names, aliases, rel): what the portal masks against. */
export function peopleNow() {
    const chat = ctx().chat ?? [];
    return [...(framesOf(chat, Math.max(0, chat.length - 1), castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
}
/**
 * Engine text for the model through the name portal (before ST macros run): unknown people's names and aliases become
 * their unknownAs and {{npc:id}} renders as the shown name; an unknown id shows as the bare id, with a console warning.
 * `keepGate` leaves the gated {{npc!:id}} line for the final pass in applyFacts.
 */
export function renderTokens(text, { keepGate = false } = {}) {
    return maskText(text, peopleNow(), { keepGate, onUnknown: id => console.warn(`[WorldScrawl] {{npc:${id}}}: no cast NPC has that id; shown as "${id || 'someone'}".`) });
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
/** The lore index line and the fed-lore block for factsText. The index names what is on file; it does not tell the narrator to tag a request. */
export function loreBits(loc) {
    const chain = loreChain(loc);
    if (!chain.length) return {};
    const fed = fedLore(loc);
    return {
        lore_index: P('narration.lore_index', { lore_places: chain.map(c => c.name).join(', ') }),
        lore_fed: fed.length ? P('narration.lore_block', { lore: fed.map(c => `- ${c.name}: ${c.text}`).join('\n') }) : '',
    };
}
/** People here, with every field the after-reply tracker may change, as the model may see them: the shown name and the opaque handle. Not the narrator prompt. */
export function listedPeople(chat, id, loc) {
    const pack = castPack();
    if (!pack?.npcs?.length || !chat?.length) return [];
    try {
        const env = npcEnv(chat, loc);
        return presentAt(chat, id, pack.npcs, env).map(p => {
            const stance = p.disposition?.[PLAYER];
            return {
                id: handleOf(p.id), name: shownName(p), looks: p.looks || '', body: p.body || '', outfit: p.outfit || '',
                unknownAs: p.unknownAs || '', nameKnown: p.known?.known !== false,
                facts: [...(p.facts ?? [])], memory: [...(p.memory ?? [])],
                stance: stance?.value || '', stanceReason: stance?.reason || '',
            };
        });
    } catch (e) { console.warn('[WorldScrawl] tracker people', e.message); return []; }
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
const APPEAR_KEY = 'worldscrawl_appearance'; // pending/failed appearance rebuilds per swipe
const FOCUS_KEY = 'worldscrawl_focus';
let pendingNpc = []; // ws_npc tool calls, stamped on the reply
function baseCastPack() {
    const id = activeWorld || defaultWorldId;
    return (id && worldCasts.get(id)) || (defaultWorldId && worldCasts.get(defaultWorldId)) || null;
}
// The live map for every NPC-side check (found, follow/stay, near, sightings, people here, schedules):
// the world's places plus rooms this chat's map changes made. The server's effective map already drops
// removed and moved rooms, so exists is "on that map", not "on the map and absent from relocate".
// resolveSchedulePlace follows a relocate key only when the address is missing here. Refreshed whenever
// the chat's active patches change (refreshLivePlaces); until then, and with no patches, the world's own places.
let livePlaces = null; // { key, pack }
const liveKey = () => `${activeWorld || defaultWorldId}\u0000${patchSig()}`;
export async function refreshLivePlaces() {
    try {
        const base = baseCastPack(); if (!base) { livePlaces = null; return; }
        const key = liveKey();
        if (!patchSig()) { livePlaces = null; return; }
        if (livePlaces?.key === key) return;
        // api() returns {ok, status, body}. The place list is body.places. Reading the wrapper
        // itself yields an empty set and every schedule stop looks gone while a patch is on.
        const r = await api(`/cast/places?world=${encodeURIComponent(activeWorld || defaultWorldId)}`, { method: 'POST', body: JSON.stringify(mapCtx()) });
        const w = r?.ok ? r.body : null;
        const places = Array.isArray(w?.places) ? w.places : null;
        if (!places) {
            // A failed or shapeless answer is not an empty map. Leave the last good pack; a new
            // signature simply falls back to the world's own places until a refresh succeeds.
            console.warn('[WorldScrawl] live places', r?.ok ? 'the server answer had no place list' : `the server answered ${r?.status ?? 'no status'}`);
            return;
        }
        const labels = w.place_labels && typeof w.place_labels === 'object' && !Array.isArray(w.place_labels) ? w.place_labels : {};
        livePlaces = { key, pack: { ...base, places: new Set(places), subs: new Set(Array.isArray(w.subs) ? w.subs : []), regions: new Set(Array.isArray(w.regions) ? w.regions : []), elsewhere: Array.isArray(w.elsewhere) ? w.elsewhere : base.elsewhere, names: Array.isArray(w.place_names) ? w.place_names : base.names, labels: { ...base.labels, ...labels } } };
    } catch (e) { console.warn('[WorldScrawl] live places', e.message); }
}
function castPack() {
    const base = baseCastPack();
    return base && livePlaces && livePlaces.key === liveKey() ? livePlaces.pack : base;
}
// The name portal reads the chat (handle salt) and the map's place names through these.
configureNames({ reveal: () => revealNamesOn(), salt: () => ctx().getCurrentChatId?.() ?? ctx().chatId ?? '', places: () => castPack()?.names ?? [], people: () => peopleNow() });
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
/** Folded person at this message, with the same clock the card uses, so an expired layer is already gone. */
function appearanceNpc(chat, msgId, cast, id) {
    return npcAt(chat, msgId, cast, id, i => npcClock(chat, i));
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
    const exists = a => !!a && addresses.has(a);
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
    for (const s of stubs) if (want.has(s.id)) base.push({ level: 'elsewhere', id: s.id, name: s.name, text: s.lore }); // name-ok: a stub place
    return base;
}
function matchStubLore(place) {
    const key = normName(place);
    if (!key) return null;
    return (castPack()?.elsewhere ?? []).find(s => !s.shadowed && s.lore && (normName(s.name) === key || s.id === key.replace(/ /g, '_') || nameIn(place, s.name))) ?? null; // name-ok: a stub place
}
function addNpcStamp(msg, stamp) {
    msg.extra = msg.extra ?? {};
    const swipe = swipeOf(msg);
    const row = { ...stamp, swipe };
    if (!row.identity) {
        const owner = row.owner || `o_${Math.random().toString(36).slice(2, 10)}`;
        row.owner = owner;
        row.decisionRev = row.decisionRev ?? 1;
        row.identity = { chat: ctx().chatId ?? ctx().getCurrentChatId?.() ?? '', message: msg.extra?.worldscrawl_mid || '', swipe, domain: row.type, npc: row.id, owner };
        if (!row.identity.message) {
            msg.extra.worldscrawl_mid = msg.extra.worldscrawl_mid || `m_${Date.now().toString(36)}`;
            row.identity.message = msg.extra.worldscrawl_mid;
        }
    }
    msg.extra[NPC_KEY] = [...(Array.isArray(msg.extra[NPC_KEY]) ? msg.extra[NPC_KEY] : []), row];
}
/**
 * The only writer of npc_name stamps. `target` is who (a handle, id, name or unknownAs), `heard` the name said.
 * Model sources (tracker, flag) must pass the portal's rules (judgeLearn: present, not yet known, the real name or an
 * alias, spoken in dialogue or in the player's line); a refusal is noted on the call log. The player's [name] and
 * /ws-name (source bracket) always land, and a rule they skipped is kept on the stamp as `override` for the inspector.
 * {ok, reason, id, name}.
 */
async function learnName(msg, { target, heard = '', source = 'bracket' } = {}) {
    const c = ctx(), chat = c.chat ?? [];
    const at = Math.max(0, chat.indexOf(msg));
    const cast = castPack()?.npcs ?? [];
    const folded = [...(framesOf(chat, at, cast).at(-1)?.values() ?? [])];
    const people = folded.length ? folded : cast;
    const person = findPerson(target, people);
    const player = source === 'bracket';
    if (!person) {
        const reason = `No saved person is called "${String(target ?? '').trim()}".`;
        if (!player) noteCall(at, { kind: 'name learn', status: 'skipped', reason: `${source}: ${reason}` });
        return { ok: false, reason };
    }
    let present = [];
    try { const loc = await currentLocation(); present = presentAt(chat, at, cast, npcEnv(chat, loc)); } catch { present = []; }
    const ui = (() => { for (let i = at - 1; i >= 0; i--) if (chat[i]?.is_user) return i; return -1; })();
    const said = ui >= 0 ? chat[ui]?.mes ?? '' : '';
    const story = msg.is_user ? '' : msg.mes ?? '';
    const j = judgeLearn({ person, present, heard: heard || (player ? person.name : ''), said: msg.is_user ? msg.mes ?? '' : said, story }); // name-ok: the player's own [name]
    if (!j.ok && !player) {
        noteCall(at, { kind: 'name learn', status: 'skipped', reason: `${source}: ${j.reason}` });
        return { ok: false, reason: j.reason, id: person.id, name: person.name }; // name-ok: result for the inspector
    }
    const swipe = swipeOf(msg);
    msg.extra = msg.extra ?? {};
    msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => !(s?.type === 'npc_name' && s.source === source && (s.swipe ?? 0) === swipe && s.id === person.id));
    addNpcStamp(msg, { type: 'npc_name', id: person.id, who: PLAYER, source, ...(j.ok ? {} : { override: j.reason }) });
    return { ok: true, reason: j.ok ? j.reason : `player override: ${j.reason}`, id: person.id, name: person.name }; // name-ok: result for the inspector
}
/** [name] /ws-name: the player's own name learn (always lands; see learnName). */
async function learnNameOn(msg, name) {
    const who = String(name ?? '').trim();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_bracket = { verb: 'name', target: who };
    if (!who) { msg.extra.worldscrawl_bracket.status = 'rejected'; msg.extra.worldscrawl_bracket.reason = '[name] needs a name.'; return { ok: false, reason: '[name] needs a name.' }; }
    const r = await learnName(msg, { target: who, heard: who, source: 'bracket' });
    if (!r.ok) { msg.extra.worldscrawl_bracket.status = 'rejected'; msg.extra.worldscrawl_bracket.reason = r.reason; return r; }
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
    const n = findPerson(name, folded);
    if (!n) return { ok: false, reason: `No saved person is called ${name}.` };
    addNpcStamp(msg, { type: 'npc_rel', id: n.id, who: PLAYER, state });
    syncSwipeExtra(msg);
    await ctx().saveChat?.();
    return { ok: true, name: n.name, state }; // name-ok: result for the inspector
}
/** Judge a found name against the room the party is in right now (for the tool's answer, before the reply is stamped). */
async function judgeFoundNow(name) {
    const loc = await currentLocation();
    const chat = ctx().chat ?? [];
    const env = npcEnv(chat, loc);
    const end = Math.max(0, chat.length - 1);
    const folded = [...(framesOf(chat, end, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const n = findPerson(name, folded);
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
        const n = findPerson(nm, folded);
        if (!n) { decisions.push({ swipe, name: nm, id: '', ok: false, reason: `No saved person is called "${nm}".`, source, where: '', place: '' }); continue; }
        const j = judgeFound(n, env.clock(at), env.playerAt(at), env);
        decisions.push({ swipe, name: n.name, id: n.id, ok: !!j.ok, reason: j.reason, source, where: j.where ?? '', place: j.place ?? '' }); // name-ok: found card (player-facing)
        if (j.ok) addNpcStamp(msg, { type: 'npc_found', id: n.id, where: j.where ?? '', place: j.place, source });
    }
    msg.extra[FOUND_KEY] = [...prev, ...decisions];
    if (source === 'bracket') msg.extra.worldscrawl_bracket = { verb: 'found', target: list.join(', '), status: decisions.every(d => d.ok) ? 'ok' : 'rejected', reason: decisions.map(d => d.reason).join(' ') };
    syncSwipeExtra(msg);
    await c.saveChat?.();
    try { broadcastMapState(); } catch { /* map window may not be open */ }
    return decisions;
}
// The gated name lines this pass put in the facts block, as rendered: the one place a real name may be (the leak check skips them).
let gateLines = [];
/** People-here text for the narrator. Empty when nobody saved is in the scene, so turns without them stay as they were. */
function npcPromptBits(loc) {
    gateLines = [];
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
        const gate = p => { gateLines.push(P('narration.name_gate', { shown: shownName(p), name: p.name })); return P('narration.name_gate', { shown: shownName(p), name: `{{npc!:${p.id}}}` }); }; // name-ok: the gated line itself
        const sl = npcSlices(present, focus, { tiers: npcTiers(present, focus, { chat, index: chat.length - 1, said, asked }), pc: env.pc, gate });
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
    const prompt = P('npc.disposition', { name: shownName(person), line: maskForModel(person.line), party: partyText(), said: String(said ?? '').slice(0, 800), options: optionLines(DISPO_OPTS) });
    const hit = await askValid('disposition', prompt, pickKey(DISPO_OPTS));
    return hit?.key ?? 'indifferent';
}
async function askWho(loc, said, present) {
    await ensurePrompts();
    const opts = [...present.map(p => ({ key: handleOf(p.id), label: shownName(p) })), { key: 'nobody', label: 'nobody in particular' }];
    const prompt = P('npc.who', { party: partyText(), place: displayName(loc), said: String(said ?? '').slice(0, 800), options: optionLines(opts) });
    const hit = await askValid('who', prompt, pickKey(opts));
    return hit?.key && hit.key !== 'nobody' ? present.find(p => handleOf(p.id) === hit.key)?.id ?? null : null;
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
    if (!loc || !calendarLib) {
        // No player location: still refresh appearance the cast viewer is showing. Sighting and disposition need a room.
        await ensureAppearanceRebuilds(chat.length - 1).catch(e => console.warn('[WorldScrawl] appearance rebuild', e));
        return;
    }
    const index = chat.length - 1;
    try {
        const env = npcEnv(chat, loc);
        const clock = env.clock(index);
        const here = env.playerAt(index);
        const frame = framesOf(chat, index, pack.npcs);
        const now = frame[frame.length - 1];
        const said = userMsg.mes ?? '';
        const seeking = /\b(find|seek|where is|look for|ask after|ask about)\b/i.test(said);
        if (now) for (const n of now.values()) {
            const oneOff = n.seen_at && !(n.schedule ?? []).some(e => !e.broken);
            if (seeking && oneOff && (nameIn(said, n.name) || nameIn(said, n.id)) && !n.seeks.some(s => s.day === clock.day)) addNpcStamp(userMsg, { type: 'npc_seek', id: n.id, day: clock.day }); // name-ok: inbound match (the player's words)
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
    } catch (e) { console.warn('[WorldScrawl] npc turn', e?.message || e); }
    // Same pending-only refresh as the no-location path. A resolved person is not asked.
    await ensureAppearanceRebuilds(index).catch(e => console.warn('[WorldScrawl] appearance rebuild', e));
}
function knownNpcNames(chat) {
    const pack = castPack();
    const names = [...(pack?.names ?? []), ...(pack?.npcs ?? []).flatMap(n => [n.name, n.id])]; // name-ok: inbound match
    const frames = framesOf(chat, chat.length - 1, pack?.npcs ?? []);
    const end = frames[frames.length - 1];
    if (end) for (const n of end.values()) names.push(n.name, n.id); // name-ok: inbound match
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
/** Approve on the Remember card. `edited` = {card}: the card exactly as the player typed it (Approve edited). */
async function keepRemember(id, edited = null) {
    const c = ctx(), msg = c.chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return;
    const nid = noticeIdOf(card, 'remember');
    return once(nid, async () => {
        if (!markDecided(msg, nid, edited ? 'adjust' : 'approve', { swipe: swipeOf(msg), text: `remember ${edited?.card?.name || card.name}` })) return; // decided once: a second Approve is a no-op
        try { await keepRememberNow(c, msg, card, id, edited); } catch (e) { unmarkDecided(msg, nid); renderPatchCards(); throw e; }
    });
}
/**
 * The Remember card's editor values over a parsed card: `changed` keys take the typed text, the rest stay. Made-up (⚠)
 * marks go only from the fields the player changed. {got} or {error}.
 */
function rememberWith(got, values = {}, changed = []) {
    const keys = changed.filter(k => k !== '_intent' && C.REMEMBER_FIELDS.some(([f]) => f === k));
    const v = { ...C.rememberValues(got), ...Object.fromEntries(keys.map(k => [k, String(values[k] ?? '')])) };
    let disposition = got.disposition ?? null;
    if (keys.includes('starts')) {
        const m = /^\s*([A-Za-z]+)\s*(?:[—:\-–]\s*([\s\S]*))?$/.exec(v.starts);
        const value = m ? Npc.matchEnum(m[1], Npc.DISPOSITIONS) : null;
        if (v.starts.trim() && !value) return { error: `Starts: one of ${Npc.DISPOSITIONS.join(', ')}, then an optional reason.` };
        disposition = value ? { value, reason: String(m[2] ?? '').trim() } : null;
    }
    const out = readRememberAnswer({ name: v.name, unknownAs: got.unknownAs ?? '', personality: { summary: v.line, manner: v.manner, speech: v.voice }, appearance: { summary: v.looks, body: v.body, outfit: v.outfit },
        history: v.history, facts: v.facts.split('\n').map(x => x.trim()).filter(Boolean), invented: C.inventedAfter(got, keys), disposition });
    if (!out) return { error: 'A remembered person needs a name and a line.' };
    if (!disposition) delete out.disposition;
    return { got: out };
}
const REMEMBER_BLANK = { manner: '', voice: '', looks: '', body: '', outfit: '', history: '', unknownAs: '', facts: [], invented: [] };
/** The remember model call for `name` at message `id`: a parsed card, or null after two unusable answers. */
async function askRemember(id, name, { prefetch = false, hint = '', keep = null } = {}) {
    const chat = ctx().chat ?? [];
    const [, loc] = await Promise.all([ensurePrompts(), currentLocation().catch(() => null)]);
    const back = readBack(chat.slice(0, id + 1).filter(m => !m.is_system).map((m, i) => ({ text: m.mes ?? '', index: i })), name);
    const story = back.messages.map(m => m.text).join('\n').slice(0, 6000);
    const kept = Object.entries(keep ?? {}).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `- ${C.REMEMBER_FIELDS.find(([f]) => f === k)?.[1] ?? k}: ${String(v).trim()}`);
    const again = hint || kept.length ? `\n\n${P('npc.remember_again', { hint: hint || '(none)', kept: kept.join('\n') || '(none)' })}` : '';
    const prompt = P('npc.remember', { name, place: loc ? displayName(loc) : 'here', story: story || '(nothing was said yet)' }) + again;
    const kind = prefetch ? 'remember (prefetch)' : 'remember';
    let got = null;
    for (let t = 0; t < 2 && !got; t++) {
        try { got = readRememberAnswer(parseJsonAnswer(await gen(kind, { prompt, systemPrompt: P('npc.remember_system', { reply: baseReply('json') }), responseLength: 900 }, { at: id, retry: t > 0 }))); } catch { got = null; }
        if (!got) markLast(id, kind, 'failed', 'answer was not a usable person');
    }
    if (got && keep) got = rememberWith(got, keep, Object.keys(keep)).got ?? got; // what the player typed stays exactly
    return got;
}
// Prefetch: the remember call starts when the card first shows (once per card id). The answer is cached on the card
// (msg.extra, per swipe) so a redraw never calls again; Approve uses it, or awaits the call still in flight.
const rememberFlights = new Map(); // card nid -> promise of the parsed card (or null)
function prefetchRemember(id, ask = {}) {
    const msg = ctx().chat?.[id], card = msg?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return null;
    card.nid = card.nid || newNoticeId('remember');
    if (card.proposal?.name === card.name && card.proposal.got) return Promise.resolve(card.proposal.got);
    if (rememberFlights.has(card.nid)) return rememberFlights.get(card.nid);
    if (card.proposal?.failed && card.proposal.name === card.name) return null; // failed: wait for Check again
    const name = card.name, gen = card.gen ?? 0;
    const p = askRemember(id, name, { prefetch: true, ...ask }).catch(() => null).then(got => {
        if ((card.gen ?? 0) !== gen) return got; // a newer Check again replaced this call
        card.proposal = got ? { name, got } : { name, failed: true };
        syncSwipeExtra(msg);
        ctx().saveChat?.();
        renderPatchCards();
        return got;
    }).finally(() => { if (rememberFlights.get(card.nid) === p) rememberFlights.delete(card.nid); });
    rememberFlights.set(card.nid, p);
    return p;
}
/** Check again (and Rewrite with this: a Change note, and the fields the player typed, which stay exactly). */
function retryRemember(id, { hint = '', keep = null } = {}) {
    const card = ctx().chat?.[id]?.extra?.[REMEMBER_KEY];
    if (!card || card.status !== 'review') return null;
    if (String(keep?.name ?? '').trim()) card.name = String(keep.name).trim();
    delete card.proposal;
    card.gen = (card.gen ?? 0) + 1;
    rememberFlights.delete(card.nid);
    const p = prefetchRemember(id, { hint, keep: keep && Object.keys(keep).length ? keep : null });
    renderPatchCards();
    return p;
}
async function keepRememberNow(c, msg, card, id, edited) {
    const chat = c.chat ?? [];
    const name = card.name;
    let got = edited?.card ?? null;
    if (!got) {
        if (card.proposal?.name === name && card.proposal.got) got = card.proposal.got; // prefetched: instant
        else if (rememberFlights.has(card.nid)) got = await rememberFlights.get(card.nid); // in flight: never a second call
    }
    if (!got) got = await askRemember(id, name);
    if (!got) got = { ...REMEMBER_BLANK, name, line: 'Met in this scene.' };
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
    const npc = npcAt(chat, chat.length - 1, pack?.npcs ?? [], id, i => npcClock(chat, i));
    if (npc?.lasting?.unresolved) { const error = 'Lasting appearance is unresolved. Export waits until that rewrite succeeds.'; toastr.warning(`WorldScrawl: ${error}`); return { ok: false, error }; }
    const lasting = npc?.lasting;
    const looks = npc?.looksHow === 'pending' || npc?.looksHow === 'failed' ? '' : (npc?.looks ?? '');
    const record = npc ? authorRecord({ ...npc, body: lasting?.body ?? npc.body, outfit: lasting?.outfit ?? npc.outfit, looks, base: { body: lasting?.body ?? npc.body ?? '', outfit: lasting?.outfit ?? npc.outfit ?? '', looks } }) : null;
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
            return { ...rest, record, inCast: !!castNpc, diff: castNpc ? fileDiff(castNpc, n) : null, appearanceJob: appearanceJobFor(chat ?? [], n.id) };
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
            try { const w = npcWhy(n, i, env); const g = w.sighting; if (g?.active && g.roll != null) rolls.push({ kind: 'roll', label: `${n.name} sighting${g.sought ? ' (by name)' : ''}`, roll: g.used, chance: g.now, seekRoll: g.seekRoll, present: g.wouldShow }); } catch { /* skip */ } // name-ok: inspector
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
const CHAT_EDIT_TYPES = new Set(['npc_fact', 'npc_memory', 'npc_disposition', 'npc_appearance', 'npc_baseline', 'npc_schedule']);
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
    const person = npcAt(chat, i, castPack()?.npcs ?? [], id);
    for (const s of stamps) {
        if (s.type !== 'npc_baseline') { addNpcStamp(msg, s); continue; }
        const owner = makeOwner({
            type: 'npc_baseline', kind: 'baseline', id, field: s.field === 'outfit' ? 'outfit' : 'body', text: s.text,
            lasts: null, start: npcClock(chat, i).elapsed ?? 0, chatId: d.chatId, message: msg.extra?.worldscrawl_mid || '', swipe: swipeOf(msg), source: 'map',
        });
        if (!owner.identity.message) {
            msg.extra = msg.extra ?? {};
            msg.extra.worldscrawl_mid = msg.extra.worldscrawl_mid || `m_${Date.now().toString(36)}`;
            owner.identity.message = msg.extra.worldscrawl_mid;
        }
        owner.candidate.epoch = ownerEpoch(msg);
        addNpcStamp(msg, owner);
        await fillCandidate(chat, owner.identity, { baseline: person?.pinned || { body: person?.body ?? '', outfit: person?.outfit ?? '' }, name: person?.name || id, elapsed: npcClock(chat, i).elapsed });
    }
    syncSwipeExtra(msg);
    await c.saveChat?.();
    renderPatchCards();
    broadcastMapState();
    return { ok: true, count: stamps.length, msg: i };
}
function npcDetail(id) {
    // The narrator names people by their handle (or a name it was shown): resolve through the portal, answer masked.
    const people = peopleNow();
    const npc = findPerson(id, people);
    if (!npc) return 'No saved person with that id is here.';
    return maskText(npcDetailText(npc), people);
}
function npcDetailText(npc) {
    const bits = [`Personality: ${npc.line}`];
    if (npc.manner) bits.push(`Manner: ${npc.manner}`);
    if (npc.voice) bits.push(`Speech: ${npc.voice}`);
    if (npc.base && (npc.base.looks || npc.base.body || npc.base.outfit)) {
        bits.push(`Base Looks: ${npc.base.looks || '—'}`);
        if (npc.base.body) bits.push(`Base Body: ${npc.base.body}`);
        if (npc.base.outfit) bits.push(`Base Wearing: ${npc.base.outfit}`);
    }
    if (npc.effects?.length) bits.push(`Active effects: ${npc.effects.map(e => {
        const lasts = e.lasts ? ` for ${e.lasts}m` : ' (lasting)';
        const by = e.by === 'player' ? ', player edit' : '';
        return `${e.intent}${lasts}${by}`;
    }).join('; ')}`);
    if (npc.looks) bits.push(`Looks now (${npc.appearanceHow || 'base'}): ${npc.looks}`);
    if (npc.body) bits.push(`Body: ${npc.body}`);
    if (npc.outfit) bits.push(`Wearing: ${npc.outfit}`);
    if (npc.memory?.length) bits.push(`Memory: ${npc.memory.join('; ')}`);
    if (npc.deep?.history) bits.push(`History: ${npc.deep.history}`);
    if (npc.deep?.secrets?.length) bits.push(`Secrets: ${npc.deep.secrets.join('; ')}`);
    if (npc.deep?.relationships) bits.push(`Relationships: ${Object.entries(npc.deep.relationships).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    return bits.filter(Boolean).join('\n');
}
const SCOPE_NOT_GIVEN = 'not judged, so the default';
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
    if (action === 'appearance') {
        // Keep an empty intent: the reply handler rejects it when nothing changed, instead of dropping it.
        const intent = String(args.intent ?? args.text ?? '').trim();
        const lasts = lastsMinutes(args.lasts);
        const stamp = { type: 'npc_appearance', id, intent, ...(args.fields != null && args.fields !== '' ? { fields: args.fields } : {}), ...(lasts ? { lasts } : {}) };
        for (const f of ['looks', 'body', 'outfit']) if (typeof args[f] === 'string' && args[f].trim()) stamp[f] = String(args[f]).trim();
        // No scope given: light, and the card says it was not judged rather than showing a reason nobody gave.
        const given = String(args.scope ?? '').trim();
        stamp.scope = appearanceScope(given);
        const why = given ? String(args.why ?? args.scope_reason ?? '').trim() : SCOPE_NOT_GIVEN;
        if (why) stamp.why = why.slice(0, 200);
        return stamp;
    }
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
        const moveTools = toolsOn();
        text = factsText(loc, move, moveTools, { date: d ? calendarLib.describeDate(d) : '', weather: placeWeatherNow(loc)?.line ?? '', took: move?.seconds && calendarLib ? calendarLib.formatDuration(move.seconds) : '', dig: um.worldscrawl_dig, digFailed: um.worldscrawl_dig_failed, look: um.worldscrawl_look, newDoor: um.worldscrawl_new_door, lookAround: ui >= 0 && LOOK_AROUND_RE.test(c.chat[ui].mes ?? '') && !(um.worldscrawl_look && (um.worldscrawl_look.via || um.worldscrawl_look.window)), door: um.worldscrawl_door, open: doorOverrides(), moveTools, ...loreBits(loc), ...npcPromptBits(loc) });
        reminder = arrivalReminder(loc, move);
        const ep = expiryPending?.chat === chatKey() && expiryPending.to === loc.address ? expiryPending : null;
        if (ep) { ep.used = true; if (ep.line) text = `${text}\n${ep.line}`; }
        const rn = ep ? '' : relocationNote(c.chat ?? [], loc, partyText());
        if (rn) text = `${text}\n${rn}`;
        else if (!ep) { const am = await aftermathNote(c.chat ?? [], loc).catch(() => ''); if (am) text = `${text}\n${am}`; }
        const wf = await waitFacts(c.chat ?? [], loc);
        if (wf) text = `${text}\n${wf}`;
        const gone = expiryNarratorNote(freshPersonExpiries(c.chat ?? [], (c.chat ?? []).length - 1, partyText()), partyText());
        if (gone) text = `${text}\n${gone}`;
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    // The prompt choke point: every person name in the block goes through the portal (the gated name line renders here).
    try {
        const people = peopleNow();
        text = maskText(text, people); reminder = maskText(reminder, people);
        // The check: an unknown person's name or alias left in the block (outside the gated lines) is a leak. Never blocks the turn.
        const leaks = nameLeaks(gateLines.reduce((t, g) => t.split(g).join(''), `${text}\n${reminder}`), people);
        if (leaks.length) {
            const reason = `the narrator's facts block names ${leaks.map(l => `"${l.name}"`).join(', ')} before the player learned it`;
            console.warn(`[WorldScrawl] name leak: ${reason}`);
            noteCall(undefined, { kind: 'name leak', status: 'failed', reason });
        }
    } catch (e) { console.warn('[WorldScrawl] name mask:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    // Small models weigh the last lines most: on a move/travel turn, repeat where the turn ends after the player's message.
    c.setExtensionPrompt(REMINDER_KEY, reminder, 1 /* IN_CHAT */, 0, false, 0 /* SYSTEM */);
}


// ---- Person expiries: a temporary appearance or fact that ran out. The replay already dropped it; these name it.
const elapsedAt = chat => i => npcClock(chat, i).elapsed;
/** The expiries between game times `before` and `after`, with each person as they are at message `end`. `party` words "known only as". */
function personExpiriesIn(chat, before, after, party = partyText(), end = (chat?.length ?? 0) - 1) {
    const items = personExpiriesBetween(chat, before, after, elapsedAt(chat));
    if (!items.length) return [];
    const cast = castPack()?.npcs ?? [];
    return describeExpiries(items, id => npcAt(chat, end, cast, id, i => npcClock(chat, i)), party);
}
/** The expiries the reply after message `end` has not narrated yet (see expiryWindow). */
function freshPersonExpiries(chat, end, party = partyText()) {
    if (!chat?.length || end < 0) return [];
    const { before, after } = expiryWindow(chat, end, elapsedAt(chat));
    return personExpiriesIn(chat, before, after, party, end);
}
/** One "[Engine: ...]" system notice for expiries not announced yet, like a place expiry's. Never in the prompt. */
async function postPersonExpiryNotices() {
    const c = ctx(), chat = c.chat ?? [];
    if (!isOn() || !chat.length) return null;
    const seen = noticedExpiries(chat);
    const items = freshPersonExpiries(chat, chat.length - 1, 'you').filter(it => !seen.has(expiryKey(it)));
    if (!items.length) return null;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: expiryNoticeText(items),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: NPC_EXPIRED_KIND, worldscrawl_notice_people: items.map(it => ({ key: it.key, ends: it.ends, id: it.id, kind: it.kind, name: it.name, who: it.who, what: it.what })) } };
    chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    return msg;
}
/**
 * The expiry notice's Edit: the player's own Body/Outfit for what the person went back to. It becomes a normal
 * lasting appearance change on the notice (owner, reviewed as typed text, approved through settleNpc), so it has
 * the usual Edit / Turn off / Undo afterwards and deleting the notice removes it.
 */
async function editExpiryRevert(at, id, text = {}) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[at];
    if (msg?.extra?.worldscrawl_notice_kind !== NPC_EXPIRED_KIND) return { ok: false, error: 'That notice is gone.' };
    const p = (msg.extra.worldscrawl_notice_people ?? []).find(x => x?.id === id);
    if (!p) return { ok: false, error: 'That person is not on this notice.' };
    const elapsed = npcClock(chat, at).elapsed;
    if (!Number.isFinite(elapsed)) return { ok: false, error: 'The game clock is not available yet. Try again once it has loaded.' };
    const live = npcAt(chat, at, castPack()?.npcs ?? [], id, i => npcClock(chat, i));
    if (!live) return { ok: false, error: 'That person is not in this chat.' };
    const typed = { body: String(text.body ?? live.body ?? ''), outfit: String(text.outfit ?? live.outfit ?? '') };
    const touched = ['body', 'outfit'].filter(f => typed[f].trim() && typed[f].trim() !== String(live[f] ?? '').trim());
    if (!touched.length) return { ok: false, error: 'The edited text is the same as now.' };
    const owner = makeOwner({
        id, intent: `after "${p.what}" wore off: ${touched.join(' and ')} as you wrote it`, fields: touched.join(','), layer: {},
        lasts: null, start: elapsed, chatId: c.chatId ?? c.getCurrentChatId?.() ?? '', message: messageKey(msg), swipe: swipeOf(msg), source: 'expiry_edit', why: 'text edited by you',
    });
    owner.candidate.epoch = ownerEpoch(msg);
    addNpcStamp(msg, owner);
    const row = (msg.extra[NPC_KEY] ?? []).find(s => s?.owner === owner.owner);
    const drop = () => { msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => s !== row); if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY]; };
    const seeded = reviewTyped(chat, owner.identity, typed, { baseline: live.pinned, elapsed });
    if (!seeded.ok) { drop(); return seeded; }
    const res = await settleNpc(chat, owner.identity, row.decisionRev, 'approve', { token: row.candidate.token, elapsed });
    if (!res?.ok) { drop(); syncSwipeExtra(msg); await c.saveChat?.(); }
    return res ?? { ok: false, error: 'not saved' };
}

/** How a person looked just before a temporary change ran out (the clock held at `ends` - 1 s): the expiry card's "before". */
function npcBefore(chat, at, id, ends) {
    return npcAt(chat, at, castPack()?.npcs ?? [], id, i => { const k = npcClock(chat, i); return Number.isFinite(ends) && k.elapsed >= ends ? clockOf(ends - 1) : k; });
}
/**
 * Approve edited on a kept appearance change: the typed Body/Outfit become the change (the same rules as the review
 * card's Approve edited, no model call); an edited Change line alone asks again (it comes back as a review card).
 * A failed typed save leaves the kept change as it was.
 */
async function editKeptAppearance(chat, identity, rev, { intent = '', typed = null } = {}) {
    const end = Math.max(0, chat.length - 1);
    const elapsed = npcClock(chat, end).elapsed;
    if (!Number.isFinite(elapsed)) return { ok: false, error: 'The game clock is not available yet. Try again once it has loaded.' };
    if (!typed) return settleNpc(chat, identity, rev, 'edit', { intent, layer: {}, elapsed });
    const ed = decideNpc(chat, identity, rev, 'edit', { ...(intent ? { intent } : {}) });
    if (!ed?.ok) return ed;
    const back = () => decideNpc(chat, identity, ed.rev, 'discard', {});
    const live = npcAt(chat, end, castPack()?.npcs ?? [], identity.npc, i => npcClock(chat, i));
    const seeded = reviewTyped(chat, identity, typed, { baseline: live?.pinned, elapsed });
    if (!seeded.ok) { back(); return seeded; }
    const res = await settleNpc(chat, identity, ed.rev, 'approve', { token: seeded.candidate.token, elapsed });
    if (!res?.ok) { const f = (chat ?? []).flatMap(m => m?.extra?.[NPC_KEY] ?? []).find(s => s?.owner === identity.owner); if (f?.candidate) decideNpc(chat, identity, f.decisionRev, 'discard', {}); }
    return res ?? { ok: false, error: 'not saved' };
}

function looksSummaryPrompt(name, body, outfit) {
    return P('npc.looks_summary', { name: name || 'them', body: body || '(empty)', outfit: outfit || '(empty)', reply: baseReply('json') });
}

/** Format rebuildInputs for the appearance-rebuild prompt. */
function appearanceRebuildPrompt(name, inputs) {
    const base = Object.entries(inputs.base).map(([f, v]) => `- ${f}: ${v || '(empty)'}`).join('\n');
    const intents = (inputs.intents ?? []).map((e, i) => `${i + 1}. ${e.intent} [${e.fields.join('+')}]`).join('\n') || '(none)';
    return P('npc.appearance_rebuild', {
        name: name || 'them',
        fields: (inputs.fields ?? []).join(', '),
        base,
        intents,
    });
}

/** Jobs list on the message for the current swipe (working / failed rebuilds). */
function appearJobs(msg) {
    const block = msg?.extra?.[APPEAR_KEY];
    if (!block || (block.swipe ?? 0) !== swipeOf(msg)) return [];
    return Array.isArray(block.jobs) ? block.jobs : [];
}
function setAppearJob(msg, job) {
    msg.extra = msg.extra ?? {};
    const cur = msg.extra[APPEAR_KEY];
    const jobs = (cur && (cur.swipe ?? 0) === swipeOf(msg) && Array.isArray(cur.jobs)) ? cur.jobs.slice() : [];
    const i = jobs.findIndex(j => j.id === job.id && j.key === job.key);
    if (i >= 0) jobs[i] = job; else jobs.push(job);
    msg.extra[APPEAR_KEY] = { swipe: swipeOf(msg), jobs };
}
function clearAppearJob(msg, id, key) {
    const block = msg.extra?.[APPEAR_KEY];
    if (!block || (block.swipe ?? 0) !== swipeOf(msg)) return;
    const jobs = (block.jobs ?? []).filter(j => !(j.id === id && j.key === key));
    if (jobs.length) msg.extra[APPEAR_KEY] = { swipe: swipeOf(msg), jobs };
    else delete msg.extra[APPEAR_KEY];
}

/** Same bound as a map-change question: two tries, then a visible failure. */
export const APPEARANCE_TRIES = 2;
/** This call owns the wait. A late answer is ignored even when the provider cannot abort. */
export const APPEARANCE_TIMEOUT_MS = 45000;
const appearEpoch = new WeakMap();
const appearFlights = new Map(); // `${msgId}|${id}|${key}` -> token
const newToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** A swipe or a newer rewrite makes an in-flight answer stale. */
export function invalidateAppearance(msg) {
    if (!msg) return;
    appearEpoch.set(msg, (appearEpoch.get(msg) ?? 0) + 1);
    bumpEpoch(msg);
}
const epochOf = msg => appearEpoch.get(msg) ?? 0;
const flightKey = (msgId, id, key) => `${msgId}|${id}|${key}`;
/** A working job whose call is gone (reload, crash) becomes a failed one so Retry can show. */
export function abandonStuckAppearance(msg) {
    const jobs = appearJobs(msg);
    let changed = false;
    for (const j of jobs) {
        if (j.status !== 'working') continue;
        const live = [...appearFlights.values()].includes(j.token);
        if (live) continue;
        setAppearJob(msg, { ...j, status: 'failed', kind: 'abandoned', reason: 'the rewrite stopped before it finished' });
        changed = true;
    }
    return changed;
}
/** Latest appearance job for one person on the swipe now showing, or null. */
export function appearanceJobFor(chat, id) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        abandonStuckAppearance(chat[i]);
        const jobs = appearJobs(chat[i]).filter(j => j.id === id);
        if (jobs.length) return { msg: i, ...jobs[jobs.length - 1] };
    }
    return null;
}

/** Recompose an unresolved live appearance. Does not create an owner or a cache row.
 * Rebuild appearance for NPCs that need the model. Pass `ids` to limit (e.g. just-stamped);
 * otherwise every present person with a pending appearance. Off-screen expiry waits until
 * someone is present (prepareNpcs / a later call with no ids filter).
 */
async function ensureAppearanceRebuilds(msgId, { ids = null, timeout = APPEARANCE_TIMEOUT_MS } = {}) {
    const chat = ctx().chat ?? [];
    const msg = chat[msgId];
    if (!msg || !isOn()) return;
    const pack = castPack()?.npcs ?? [];
    let targets;
    if (ids?.length) {
        targets = ids.map(id => appearanceNpc(chat, msgId, pack, id)).filter(Boolean);
    } else {
        // Pending people only, with or without a player location. A resolved person is not asked,
        // so this is not a fan-out over the cast. The cast viewer shows these same fields.
        const frame = framesOf(chat, msgId, pack, i => npcClock(chat, i)).at(-1);
        targets = [...(frame?.values() ?? [])].filter(n => n.appearanceHow === 'pending' || n.looksHow === 'pending');
    }
    abandonStuckAppearance(msg);
    const elapsed = npcClock(chat, msgId).elapsed;
    for (const npc of targets) {
        const pin = npc.pinned || { body: npc.base?.body ?? '', outfit: npc.base?.outfit ?? '' };
        if (npc.appearanceHow === 'pending' || npc.looksHow === 'pending') {
            const wrote = await recompose(chat, { npc: npc.id, at: msgId, baseline: pin, name: npc.name, elapsed, timeout }); // name-ok: masked in the owners prompt builder
            if (wrote?.msg) syncSwipeExtra(wrote.msg);
        }
    }
}


/** Chat card and the map channel both call this. Appearance changes recompose afterwards. */
async function settleNpc(chat, identity, decisionRev, action, payload = {}) {
    const end = Math.max(0, (chat?.length ?? 1) - 1);
    const elapsed = Number.isFinite(payload.elapsed) ? payload.elapsed : (calendarLib ? npcClock(chat, end).elapsed : NaN);
    const host = (chat ?? []).find(m => (m?.extra?.worldscrawl_npc ?? []).some(s => s && (s.owner === identity?.owner || s.identity?.owner === identity?.owner)));
    const at = Math.max(0, (chat ?? []).indexOf(host));
    if (action === 'retry' && identity?.owner) {
        const filled = await fillCandidate(chat, identity, { baseline: npcAt(chat, end, castPack()?.npcs ?? [], identity.npc)?.pinned, name: identity.npc, elapsed: Number.isFinite(elapsed) ? elapsed : null });
        try { if (host) syncSwipeExtra(host); await ctx().saveChat?.(); renderPatchCards(); broadcastMapState(); } catch (e) { console.warn('[WorldScrawl] npc decision refresh', e?.message || e); }
        return filled;
    }
    const res = decideNpc(chat, identity, decisionRev, action, { ...payload, elapsed });
    const touch = action === 'undo' || action === 'off' || action === 'on' || action === 'approve';
    const appearance = identity?.domain === 'appearance' || identity?.domain === 'baseline' || identity?.npc;
    if (res?.refill && identity?.owner && Number.isFinite(elapsed)) {
        const live = npcAt(chat, end, castPack()?.npcs ?? [], identity.npc, i => npcClock(chat, i));
        await fillCandidate(chat, identity, { baseline: live?.pinned || { body: '', outfit: '' }, name: live?.name || identity.npc, elapsed });
    } else if (res?.ok && touch && appearance && identity?.npc) {
        const live = npcAt(chat, end, castPack()?.npcs ?? [], identity.npc, i => npcClock(chat, i));
        const wrote = await recompose(chat, { npc: identity.npc, at, baseline: live?.pinned || { body: live?.base?.body ?? '', outfit: live?.base?.outfit ?? '' }, name: live?.name || identity.npc, elapsed });
        if (wrote?.msg) syncSwipeExtra(wrote.msg);
    }
    try {
        if (host) syncSwipeExtra(host);
        await ctx().saveChat?.();
        await applyFacts();
        renderPatchCards();
        broadcastMapState();
    } catch (e) { console.warn('[WorldScrawl] npc decision refresh', e?.message || e); }
    return res;
}

function retryAppearance(msgId, npcId, key) {
    const msg = ctx().chat?.[msgId];
    if (!msg) return Promise.resolve({ ok: false, error: 'That message is gone.' });
    const guard = `appear:${msgId}:${npcId}:${key || ''}`;
    return once(guard, async () => {
        invalidateAppearance(msg);
        for (const k of [...appearFlights.keys()]) if (k.startsWith(`${msgId}|${npcId}|`)) appearFlights.delete(k);
        if (key) clearAppearJob(msg, npcId, key);
        else for (const j of appearJobs(msg).filter(j => j.id === npcId)) clearAppearJob(msg, npcId, j.key);
        syncSwipeExtra(msg);
        await ensureAppearanceRebuilds(msgId, { ids: [npcId] });
        return { ok: true };
    }).then(r => r ?? { ok: false, error: 'Already retrying.' });
}

export { REMEMBER_KEY, APPEAR_KEY, rememberWith, editExpiryRevert, editKeptAppearance, npcBefore, freshPersonExpiries, personExpiriesIn, postPersonExpiryNotices, setRelOn, addNpcStamp, applyFacts, applyFound, castPack, discardRemember, exportNpc, judgeFoundNow, keepRemember, learnName, learnNameOn, loreChain, mapActivity, mapInspect, mapNpcs, matchStubLore, maybeSuggest, npcChatEdit, npcClock, npcDetail, npcEnv, offerRemember, pendingNpc, prefetchRemember, prepareNpcs, requestLore, retryRemember, toolNpcStamp, ensureAppearanceRebuilds, retryAppearance, appearJobs, decideNpc, fillCandidate, makeOwner, recompose, settleNpc };
