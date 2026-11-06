// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// where each actor is; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// Positions are stamped on chat messages (message.extra.worldscrawl_location) so that deleting or swiping
// a message rolls them back. A string stamp is the player's position (old chats, and still what we write
// when only the player moved). A per-actor stamp is {actorId: address}. There is no stored party: the party
// is the player (id "player") plus whoever is following them, and nobody follows yet.
import { LOOK_RE, MOVE_RE, lookOnly, stayPutLine, WAIT_TAG, waitArgs, parseWaitTag, waitReason, normalizeWsTags, unreadTags } from './words.mjs';
import { messageActivity } from './activity.mjs';
import { timeLabel } from './timelabels.mjs';
import { DECIDED_KEY, noticeIdOf, newNoticeId, decisionOf, isDecided, markDecided, unmarkDecided, once, noticeRow, lockRow, markPending, NOTICE_CSS, resolvedText } from './notices.mjs';
import { addCallNote, markCall, narratorNote, narratorStart, narratorFailure } from './calllog.mjs';
import { render as P, setPrompts, hasPrompts, sharedError, slug } from './shared.mjs';
import { PLAYER, LOC_KEY, playerAddress, partyAddresses, positionOf, placeStamp, actorHistory } from './actors.mjs';
import { exportRecord, freeId, nameIn, normName, resolveSchedulePlace } from './shared.mjs';
import { NPC_KEY, FOUND_KEY, SUGGEST_AFTER, declinesInScene, focusRules, followersAt, framesOf, absentAt, npcAt, npcPlayState, npcSlices, npcWhy, narratorView, unsavedPeople, whoAt, presentAt, readBack, readRememberAnswer, recordDiff, npcTiers, askedLoreNames, takeNameFlags, takeFoundFlags, npcForName, nameStampFor, judgeFound, foundEditOk, offMapReport, scheduleAt, sightCheck, stampSummary, takeNpcTags, NPC_FLAG_KEY, flaggedPeople, sceneStartOf, takeNpcFlags, renderNpcTokens, takeLoreFlags, loreFor, addLoreRequest, activeLore, loreRequests, LORE_KEY } from './npc.mjs';
import { WHICH_PREFIX, addNotice, bracketIntent, helpText, parseBracket, unbracket } from './brackets.mjs';
export { LOOK_RE, MOVE_RE, lookOnly, stayPutLine };
import { onMessagesDeleted, snapCarriers } from './carriers.mjs';
import { calendarLib, chatElapsed, chatWorld, defaultWorldId, effectiveWorld, listedWorlds, loadCalendar, rememberWorlds, worldLiving, worldMissing, worldName, worldNames, worldTimes } from './clock.mjs';
import { askValid, noteCall } from './dig.mjs';
import { flagMessage, onReplyForFlags, syncSwipeExtra } from './discovery.mjs';
import { api, barAction, currentLocation, doorAction, ensurePrompts, getStoredLocation, stampHistory, storedStamp } from './doors.mjs';
import { applyNudge, applyTools, chatKey, describe, ensureStartStamp, excerptOf, expiredNotice, expiryNarrated, expiryNarrationLine, expiryOptions, expiryPickPrompt, postExpiredNotice } from './expiry.mjs';
import { START_MARKER, exitsCache, exitsText, fetchLocationCached, primeCache, renderAllExits, renderStartButton, warmRooms } from './footer.mjs';
import { DIG_FAILED_NOTICE, parseIntent } from './looking.mjs';
import { mapState, openMapChannel, openMapWindow } from './mapwindow.mjs';
import { ELSEWHERE, chatAddresses, discoveredPlaces, displayName, doorFetched, doorInfo, engineMove, engineTravel, goAction, matchCandidates, moveNote, narrate, partyText, pickKey, stamp, stoodInAddresses, syncDoors } from './movement.mjs';
import { revealsDestination } from './shared.mjs';
import { changeEditUrl, mapCtx } from './patches.mjs';
import { applyFacts, applyFound, learnNameOn, offerRemember, prepareNpcs, setRelOn } from './scene.mjs';
import { addSettingsPanel } from './settings.mjs';
import { planWait, renderPatchCards, stampWait, waitNote } from './waits.mjs';
export { loadCalendar, placeWeatherNow, clockAt, chatElapsed, gameDate, effectiveWorld, worldName, chatWorld, worldSeed, chatChanges, firstSentence } from './clock.mjs';
export { doorOverrides, doorStates, barrierOf, isOpenNow, sightOf, soundOf, barStates, isBarredNow, isBarredAway, barHere, isStuck, viewOf, roomToken, doorChange, doorCandidates, openChanges, barAction, doorAction, cacheInfo, cacheKeys, ensurePrompts, getStoredLocation } from './doors.mjs';
export { expiryOptions, expiryPickPrompt, excerptOf, expiryNarrationLine, narratedView, expiredNotice, relocationNote, ensureStartStamp } from './expiry.mjs';
export { discoverSys, discoverPrompt, existingDiscovery, unmergeFlag, flagMessage, onReplyForFlags, BADTAG_TITLE, markUnreadTags, digFailedBefore } from './discovery.mjs';
export { trimAnswer, parseChoice, normKey, keyFor, matchKey, optionLines, pickKey, stepsTaken, syncDoors, applyReveals, sameWord, sameLabel, sameAsDirection, exitLabel, destLabel, collidingNames, exitLabels, placeLabel, displayName, previousAddress, findPath, matchCandidates, namedInText, alreadyText, whoMoves, partyMembers, partyText, moveNote, narrate, STAY, ELSEWHERE, UNCLEAR, OPEN, BREAK_RE, cleanAnswer, parseIntentAnswer, parseYesNo } from './movement.mjs';
export { baseReply, digSys, DIG_TRIES, pickSys, COMPASS, closeName, duplicatePlace, mergeDuplicates, NEW_PLACE, digOptions, digPrompt, readDigAnswer, namedPlace, digWordFrom } from './dig.mjs';
export { LOOK, OPEN_DOOR, CLOSE_DOOR, NEW_DOOR, DOOR_OPEN_RE, DOOR_CLOSE_RE, NO_EXIT, AROUND, WINDOW_WORD_RE, offerWindow, lookOptions, lookTargetPrompt, DOOR_LOOK, closedDoorPrompt, roomOptions, viewPickPrompt, doorOptions, doorPickPrompt, DIG_FAILED_NOTICE, travelSys, travelYesNoPrompt, intentSys, intentPrompt } from './looking.mjs';
export { VERBS, parseBracket, unbracket, SLASH_ONLY, helpText, bracketTargetPrompt, bracketIntent, exitMentioned, checkExitChoice, WHICH_PREFIX, WAY_OUT_PREFIX, LEAVING_RE, noticePrefix, unreachableText, whichText, arrival, arrivalReminder, isDirWord, glimpseLines, lookText, LOOK_AROUND_RE, newDoorLine, factsText } from './brackets.mjs';
export { renderTokens, fedLore, loreBits, refreshLivePlaces, flaggedInScene } from './scene.mjs';
export { exitsText, namedNpcsAt, START_MARKER } from './footer.mjs';
export { revealsDestination } from './shared.mjs';
export { themeVars, mapState, expandSys, openMapWindow, openWorldFolder } from './mapwindow.mjs';
export { flagHint, flagToolText, flagActionText, waitHint, patchesOn, previewOps, restampChange, opsHash, changeEditUrl, changeEditMismatch, changeDependents, toggleChange, liveEdit } from './patches.mjs';
export { isCarrier, removeChange, snapCarriers, lastLostCarriers, restoreCarriers, suggestStart, parseJsonAnswer, scopeSys, patchSys, scopePrompt, logEditCall, flagCardView, USER_FLAG_NOTE, replyAfter, SCENE_KEY, sceneOverrides, setSceneOverride, proactiveDiscovery } from './carriers.mjs';
export { modelWait, planWait, MIN_NARRATOR_WAIT, narratorWaitAction, waitAmount, proposeWait, keepWait, waitExpiryDelta, editKeptWait, discardWait, waitNote, renderPatchCards } from './waits.mjs';
export { setPrompts, P as render };
const MODULE = 'worldscrawl';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: '', nudge: DEFAULT_NUDGE, showExits: true, autoKeep: false, autoKeepWaits: false, narrateExpiries: true, proactiveDiscovery: false, flagTags: true, flagNpcs: true, reporterTools: false, moveMode: 'typed', whoMoves: '{{user}}', world: '', enableNewChats: false, showEditMessages: false };
export const OFF_NOTICE = 'WorldScrawl is turned off.';
const ENABLED_KEY = 'worldscrawl_enabled'; // in chat_metadata: this chat's on/off (saved with the chat, not rolled back by swipes)
/** Does this chat already have anything WorldScrawl stamped on it? */
export const chatHasStamps = (chat = ctx().chat ?? []) => chat.some(m => { const e = m?.extra; return e && (e[LOC_KEY] || e[MOVE_KEY] || e[WORLD_KEY] || e[CHANGE_KEY] || e.worldscrawl_notice); });
/**
 * Is WorldScrawl on in this chat? The chat's saved choice; else on if the chat already has WorldScrawl stamps
 * (older chats); else the global "Enable in new chats" setting (default off). When off it behaves as if uninstalled.
 */
export function isOn() {
    const v = ctx().chatMetadata?.[ENABLED_KEY];
    if (typeof v === 'boolean') return v;
    return chatHasStamps() || !!settings().enableNewChats;
}
const WORLD_KEY = 'worldscrawl_world'; // {id, version, rebase?, at?, from?}: which world this chat is built on (latest stamp wins)
const CHANGE_KEY = 'worldscrawl_change'; // {type: 'add_exit'|'remove_exit', ...} on the system message that made the change
const MODES = ['commands', 'typed', 'tools'];
const MOVE_KEY = 'worldscrawl_move'; // {direction, from, from_name, to, to_name} on the message that moved
const WAITCARD_KEY = 'worldscrawl_waitcard'; // {swipe, seconds, sleep, label, until, amount}: a narrator wait waiting for Keep / Adjust / Discard
const WAIT_KEY = 'worldscrawl_wait'; // {seconds, sleep, label, before}: on the message where time passed without moving
const FACTS_KEY = 'worldscrawl_facts';
const REMINDER_KEY = 'worldscrawl_arrival_reminder'; // depth 0: right after the latest user message
const TOOL_NAMES = ['ws_look', 'ws_move', 'ws_flag', 'ws_wait', 'ws_npc'];
const PATCH_KEY = 'worldscrawl_patches'; // [{type: 'patch', ops, relocate, swipe, ...}] on the message where a map change settled
const FLAG_KEY = 'worldscrawl_flag'; // {swipe, loc, note, start, status, proposal}: a flagged message's review card
const FLAGHINT_KEY = 'worldscrawl_flaghint';
const NUDGE_KEY = 'worldscrawl_nudge';

const ctx = () => SillyTavern.getContext();
const toolsOn = () => settings().moveMode === 'tools';
let pendingLocation = null;

export function settings() {
    const all = ctx().extensionSettings;
    const saved = all[MODULE] ?? {};
    // Reporter tools used to register with "Model moves with map tools". Keep them for those saves.
    // A saved reporterTools value (including off) is left alone.
    if (saved.reporterTools == null && saved.moveMode === 'tools') saved.reporterTools = true;
    all[MODULE] = Object.assign({}, DEFAULTS, saved);
    return all[MODULE];
}

/** The map server: SillyTavern's own WorldScrawl plugin route, unless the settings name another server. */
export const PLUGIN_URL = '/api/plugins/worldscrawl';
const baseUrl = () => { const u = String(settings().serverUrl || '').trim(); return !u ? PLUGIN_URL : u.replace(/\/+$/, ''); };
/** SillyTavern's CSRF token, for requests to its own plugin routes (same origin only). */
const csrfHeaders = () => { if (/^https?:/.test(baseUrl())) return {}; const t = ctx().getRequestHeaders?.()?.['X-CSRF-Token']; return t ? { 'X-CSRF-Token': t } : {}; };
const NOT_RUNNING = () => baseUrl() === PLUGIN_URL
    ? 'Is the WorldScrawl server plugin installed in SillyTavern/plugins/worldscrawl, with enableServerPlugins: true in config.yaml? Restart SillyTavern after changing either.'
    : 'Is it running?';

let mapVersion = null;
/** Every server reply carries the map version; when it changes (map files edited, server restarted) drop remembered rooms. */
export function noteMapVersion(v) {
    if (!v) return;
    if (mapVersion && v !== mapVersion) { exitsCache.clear(); doorInfo.clear(); doorFetched.clear(); console.log(`[WorldScrawl] map changed (${mapVersion} -> ${v}); cleared remembered rooms`); }
    mapVersion = v;
    const cw = chatWorld();
    const key = `${cw?.id}|${cw?.version}|${v}`;
    if (cw?.version && cw.version !== v && !versionWarned.has(key)) {
        versionWarned.add(key);
        console.warn(`[WorldScrawl] this chat was built on ${cw.id} version ${cw.version}, the server has ${v}; continuing anyway`);
        try { toastr.warning(`WorldScrawl: the map of "${cw.id}" changed since this chat started. Missing rooms or exits will be skipped.`); } catch {}
    }
}
const versionWarned = new Set();

// ---- Worlds. Which world a chat is built on is stamped on its messages (latest stamp wins), so deleting or
// swiping away a rebase stamp puts the chat back on the previous world. No stamp = the server's default world.
let activeWorld = '';
/** Picker button on the missing-world notice: move the chat onto that world (a rebase stamped on the notice; delete it to undo). */
export async function moveChatToWorld(id, index) {
    const c = ctx();
    const msg = c.chat?.[index];
    if (!msg) return;
    const list = (await api('/worlds').catch(() => null))?.body;
    rememberWorlds(list);
    const info = list?.worlds?.find(w => w.id === id);
    if (!info) { toastr.warning('That world is gone too.'); return; }
    msg.extra[WORLD_KEY] = { id: info.id, name: info.name, version: info.map_version, rebase: true, at: index, from: chatWorld()?.id ?? null };
    await c.saveChat();
    lastSyncChat = null;
    await rebuildFromChat();
    toastr.success(`This chat now uses the world "${info.name}".`);
}
let placeholderAuto = true;
let lastSyncChat = null;
/** Point all requests at the chat's world; switching worlds drops everything remembered about the old one. */
export function syncWorld() {
    const w = effectiveWorld();
    const same = (w || defaultWorldId) === (activeWorld || defaultWorldId);
    if (w !== activeWorld && same) activeWorld = w; // same world, just named: keep what's remembered
    const chatId = ctx().chatId ?? ctx().getCurrentChatId?.() ?? null;
    if (w !== activeWorld && lastSyncChat === chatId && chatId) { try { toastr.info(`WorldScrawl: this chat now uses the world "${worldName(w)}".`); } catch {} }
    lastSyncChat = chatId;
    if (w !== activeWorld) {
        console.log(`[WorldScrawl] world: ${activeWorld || '(default)'} -> ${w || '(default)'}`);
        activeWorld = w; exitsCache.clear(); doorInfo.clear(); doorFetched.clear(); mapVersion = null;
    }
    return activeWorld;
}

/** The saved room isn't in this chat's effective map (removed, merged, swiped or deleted away, or a temporary change expired):
 *  the server's blanket position resolver picks a real room (merge redirect, a surviving neighbour, the subregion/region
 *  entrance, the world start). One short system notice carries the new location (delete it to undo) and the narrator is told once. */
async function missingRoomFallback(stored) {
    const st = storedStamp();
    const r = await api('/resolve', { method: 'POST', body: JSON.stringify({ address: st?.address ?? stored, since: st?.index ?? null, history: stampHistory(st?.index ?? (ctx().chat ?? []).length), ...mapCtx() }) }).catch(() => null);
    let to = r?.ok && r.body?.address ? await fetchLocationCached(r.body.address) : null;
    if (!to) to = await fetchLocationCached(null);
    if (!to) throw new Error('WorldScrawl: /start failed.');
    const c0 = ctx(), once = `${chatKey()}|${stored}|${(c0.chat ?? []).length}|${chatElapsed()}`;
    if (r?.body?.expired && settings().narrateExpiries !== false && typeof c0.generate === 'function' && !expiryNarrated.has(once)) {
        // Narrated expiry: pick where they end up first (own pick-one call, the way in by default), move them in memory,
        // then one automatic narrator reply tells why and how; that reply carries the location stamp.
        expiryNarrated.add(once);
        const opts = expiryOptions(r.body.options ?? []), room = r.body.expired_room ?? { name: stored };
        let dest = opts.find(o => o.address === to.address) ?? opts[0] ?? null;
        await ensurePrompts();
        if (opts.length > 1 && typeof c0.generateRaw === 'function') {
            try { dest = await askValid('expiry', expiryPickPrompt(room, opts, dest?.key), pickKey(opts)) ?? dest; } catch (e) { console.warn('[WorldScrawl] expiry pick failed:', e.message); }
        }
        const picked = dest ? await fetchLocationCached(dest.address) : null;
        if (picked) to = picked;
        const via = (r.body.options ?? []).find(o => o.address === to.address)?.direction ?? '';
        const p = expiryPending = { chat: chatKey(), from: stored, to: to.address, via, line: '' };
        try { p.line = expiryNarrationLine(room, to, via, partyText(), excerptOf(c0.chat?.[room.change?.msg]?.mes)); } catch {}
        console.warn(`[WorldScrawl] ${stored} expired; narrating the move to ${to.address}`);
        setTimeout(() => { triggerExpiryNarration(p).catch(e => console.error('[WorldScrawl] expiry narration', e)); }, 0);
        return to;
    }
    console.warn(`[WorldScrawl] location ${stored} is not in world ${activeWorld || '(default)'}; resolved to ${to.address} (${r?.body?.how ?? 'start'})`);
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: r?.body?.expired ? expiredNotice(to, r.body.via) : `[Engine: that place no longer exists in this world. You're now in ${displayName(to)}.]`,
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing', worldscrawl_notice_from: stored, ...(r?.body?.expired ? { worldscrawl_notice_expired: true } : {}), [LOC_KEY]: to.address } };
    c.chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    return to;
}
// ---- Narrated expiries: one pending move per chat, held in memory until the automatic narrator reply stamps it.
let expiryPending = null;
/** Fire the automatic narrator reply (like ST's own reply); if none arrives, fall back to the plain notice. */
async function triggerExpiryNarration(p) {
    if (expiryPending !== p || p.used) return; // a reply already in progress carries it
    try { await ctx().generate('normal', { automatic_trigger: true }); } catch (e) { console.warn('[WorldScrawl] expiry narration failed:', e.message); }
    if (expiryPending === p) { expiryPending = null; await postExpiredNotice(p.from, p.to, p.via); }
}
/** The narrator reply that told the expiry gets the move's stamp (delete it to rewind). */
async function stampExpiryReply(id) {
    const p = expiryPending, c = ctx(), m = c.chat?.[id];
    if (!p || p.chat !== chatKey() || !m || m.is_user || m.is_system) return;
    m.extra = m.extra ?? {};
    m.extra[LOC_KEY] = p.to; m.extra.worldscrawl_expiry_narrated = { from: p.from, to: p.to };
    expiryPending = null;
    await c.saveChat?.();
}

async function lookAction() {
    const loc = await currentLocation();
    if (!getStoredLocation()) pendingLocation = loc.address; // first look in a chat fixes the start location
    return describe(loc);
}

async function moveAction({ direction } = {}) {
    if (!direction) return JSON.stringify({ error: 'direction is required' });
    const from = (await currentLocation()).address;
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from, direction, ...mapCtx() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return JSON.stringify({ error: d.error ?? `Move failed (${r.status})`, valid_directions: d.valid_directions ?? [] });
    }
    pendingLocation = r.body.address;
    primeCache(r.body);
    return describe(r.body);
}

function stampLocation() {
    if (!isOn()) { pendingLocation = null; return; }
    if (!pendingLocation) return;
    const chat = ctx().chat;
    const msg = chat?.[chat.length - 1];
    if (msg) {
        msg.extra = msg.extra ?? {};
        msg.extra[LOC_KEY] = placeStamp(msg.extra[LOC_KEY], PLAYER, pendingLocation);
    }
    pendingLocation = null;
}

// ---- Engine-driven movement. The engine moves the party; the model never touches the map.
let engineBusy = false;

async function goTarget(t) {
    const c = ctx();
    if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; }
    if (engineBusy) return 'WorldScrawl: already moving.';
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    engineBusy = true;
    try {
        const here = await currentLocation();
        const exit = t.direction ? here.exits.find(e => e.direction.toLowerCase() === t.direction.toLowerCase())
            : t.prefix ? null : here.exits.find(e => e.to === t.address && revealsDestination(e));
        let res;
        if (exit) res = await engineMove(exit.direction);
        else if (t.direction) res = await engineMove(t.direction);
        else {
            res = await engineTravel(t.address, t.prefix ?? null);
            if (!res.ok) { await addNotice({ loc: here, noRoute: t.label ?? t.name }); renderAllExits(); return ''; }
        }
        if (!res.ok) { toastr.warning(`${res.error} Exits: ${res.valid.join(', ') || 'none'}`); return res.error; }
        const who = partyText();
        const note = moveNote(who, res.move, exit ?? here.exits.find(e => e.direction.toLowerCase() === String(res.move.direction ?? '').toLowerCase()));
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stamp(msg, res.to, res.move);
        msg.extra.worldscrawl_engine = true; // no intent question for this message
        await c.saveChat();
        renderAllExits();
        await narrate(c);
        return '';
    } catch (e) {
        toastr.error(e.message); return e.message;
    } finally {
        engineBusy = false;
    }
}

/** The model never sees the [ws-start] marker (the prompt chat holds its own entries: replace them, the stored greeting stays). */
export function stripStartMarker(arr) {
    if (!Array.isArray(arr)) return;
    arr.forEach((m, i) => { if (typeof m?.mes === 'string' && m.mes.includes(START_MARKER)) arr[i] = { ...m, mes: m.mes.split(START_MARKER).join('').replace(/[ \t]+\n/g, '\n').trim() }; });
}

/** Generation interceptor (manifest.generate_interceptor): runs before every prompt is built. */
globalThis.worldscrawlInterceptor = async function (_chat, _size, abort, type) {
    stripStartMarker(_chat);
    _chat.forEach((m, i) => { if (m?.is_user && typeof m.mes === 'string' && m.mes.includes('[')) { const t = unbracket(m.mes); if (t !== m.mes) _chat[i] = { ...m, mes: t }; } });
    if (type === 'quiet' || type === 'impersonate' || !isOn()) return;
    try {
        const c = ctx();
        const chat = c.chat ?? [];
        const last = chat[chat.length - 1];
        const s = settings();
        const bracket = (!type || type === 'normal') && last?.is_user && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked ? parseBracket(last.mes) : null;
        if (bracket || ((!type || type === 'normal') && last?.is_user && s.moveMode === 'typed'
            && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked)) {
            const r = (bracket && await bracketIntent(last, bracket)) || await parseIntent(last);
            await c.saveChat();
            if (r.kind === 'help' || r.kind === 'bracket_failed') {
                abort(true); // answered here: the narrator is not called
                await addNotice({ loc: r.loc, kind: 'text', text: r.kind === 'help' ? helpText() : r.note });
                renderAllExits();
                return;
            }
            await c.saveChat();
            if (r.kind === ELSEWHERE || r.kind === 'which' || r.kind === 'already') {
                abort(true); // no model call: the model would only narrate a trip that didn't happen
                await addNotice(r.kind === 'which' ? { loc: r.loc, kind: 'which', candidates: r.candidates, prefix: r.prefix ?? WHICH_PREFIX }
                    : r.kind === 'already' ? { loc: r.loc, kind: 'already', name: r.name } : { loc: r.loc, noRoute: r.noRoute });
                renderAllExits();
                return;
            }
            if (r.kind === 'dig_failed') toastr.warning(`WorldScrawl: ${DIG_FAILED_NOTICE}`);
            if (r.kind === 'found' || r.kind === 'name') renderPatchCards();
            renderAllExits();
        }
        if ((!type || type === 'normal') && last?.is_user) await prepareNpcs(last);
        await applyFacts();
    } catch (e) { console.error('[WorldScrawl] interceptor failed', e); }
};

/** A system message (never in the prompt) carrying one world change; deleting it undoes the change. */
async function addChangeMessage(text, change) {
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text, extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'change', [CHANGE_KEY]: change } };
    c.chat.push(msg); c.addOneMessage(msg); await c.saveChat();
    renderAllExits();
}
/** "Village Square" for streets-like places, otherwise "Room (Building)". */
const roomLabel = l => (l.subregion?.label_rooms ? l.name : displayName(l));
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', northeast: 'southwest', southwest: 'northeast', northwest: 'southeast', southeast: 'northwest', up: 'down', down: 'up', in: 'out', out: 'in', inside: 'outside', outside: 'inside' };
/** Return exit name for a dug exit: the opposite for compass/up/down/in/out, otherwise "back". */
export const returnName = d => OPPOSITE[String(d).toLowerCase()] ?? 'back';
const hasExit = (loc, d) => !!loc?.exits?.some(e => e.direction.toLowerCase() === String(d).toLowerCase());
/** Unique id for a new room in the subregion of `near`: "<name_slug>_<time>". */
const newRoomAddress = (near, name) => `${near.address.split('/')[0]}/${(slug(name).replace(/-/g, '_') || 'room').slice(0, 30).replace(/_+$/, '')}_${Date.now().toString(36)}`; // ids: lowercase, digits, single underscores
/**
 * Build a dig (and new room) from validated parts. Returns {ok, change, text} or {ok:false, error}.
 * dest: {address} of a room, or {name, description} for a new room. Never touches the chat.
 */
export async function buildDig(here, direction, dest, { returnDirection = null, oneway = false, description = '', returnDescription = '' } = {}) {
    direction = String(direction ?? '').trim();
    if (!direction || direction.length > 30) return { ok: false, error: 'An exit needs a short name.' };
    if (hasExit(here, direction)) return { ok: false, error: `There is already an exit ${direction} here.` };
    const back = String(returnDirection ?? returnName(direction)).trim();
    const changes = [];
    let to, label;
    if (dest.address) {
        if (dest.address === here.address) return { ok: false, error: 'A passage must lead somewhere else.' };
        const t = await fetchLocationCached(dest.address);
        if (!t) return { ok: false, error: 'No such place.' };
        if (!oneway && hasExit(t, back)) return { ok: false, error: `${roomLabel(t)} already has an exit ${back}.` };
        to = t.address; label = roomLabel(t);
    } else {
        const name = String(dest.name ?? '').trim(), desc = String(dest.description ?? '').trim();
        if (!name || name.length > 40 || !desc || desc.length > 300) return { ok: false, error: 'A new room needs a short name and description.' };
        to = newRoomAddress(here, name); label = name;
        changes.push({ type: 'add_room', address: to, name, description: desc, from: here.address });
    }
    const d = description ? { description } : {};
    changes.push(oneway ? { type: 'add_exit', from: here.address, direction, to, ...d }
        : { type: 'dig', from: here.address, direction, to, ...d, return_direction: back, ...(returnDescription ? { return_description: returnDescription } : {}) });
    const text = `[Engine: a passage ${direction} to ${label} was opened${oneway ? '' : ` (back: ${back})`}.]`;
    return { ok: true, change: changes.length === 1 ? changes[0] : changes, text, to, label, direction, back: oneway ? null : back };
}
/**
 * /ws-dig <dir>[/<returndir>] <known place> | /ws-dig <dir>[/<returndir>] new <name>[: description]
 * Two-way by default (oneway=true for one-way). Undo by deleting the system message.
 */
export async function digAction(arg, { oneway = false } = {}) {
    const m = String(arg ?? '').trim().match(/^(\S+)\s+(.+)$/);
    const usage = 'Usage: /ws-dig <dir>[/<returndir>] <known place>  or  /ws-dig <dir> new <name>[: description]';
    if (!m) { toastr.warning(usage); return ''; }
    const [direction, returnDirection = null] = m[1].split('/');
    const placeText = m[2].trim();
    const here = await currentLocation();
    let dest;
    const nm = placeText.match(/^new\s+([^:]+?)\s*(?::\s*(.+))?$/i);
    if (nm) dest = { name: nm[1], description: nm[2] ?? `A newly opened space off ${roomLabel(here)}.` };
    else {
        const known = await discoveredPlaces();
        const list = [...known.values()].map(l => ({ address: l.address, name: l.name, label: l.display_name }));
        const found = known.has(placeText) ? [{ address: placeText, label: known.get(placeText).display_name }] : matchCandidates(placeText, list);
        if (found.length !== 1) { toastr.warning(found.length > 1 ? `Which one? ${found.map(x => x.label).join(', ')}` : `Not a known place: ${placeText}`); return ''; }
        dest = { address: found[0].address };
    }
    const r = await buildDig(here, direction, dest, { returnDirection, oneway });
    if (!r.ok) { toastr.warning(r.error); return ''; }
    await addChangeMessage(r.text, r.change);
    return '';
}
/** /ws-removeexit <direction>: remove an exit from the current room only. */
export async function removeExitAction(arg) {
    const direction = String(arg ?? '').trim();
    const here = await currentLocation();
    const e = here.exits.find(x => x.direction.toLowerCase() === direction.toLowerCase());
    if (!e) { toastr.warning(`No exit ${direction} here. ${exitsText(here)}`); return ''; }
    await addChangeMessage(`[Engine: the ${e.direction} exit from ${roomLabel(here)} was removed.]`, { type: 'remove_exit', from: here.address, direction: e.direction });
    return '';
}
/** The chat's default save name: "<base world> - <character or chat> - <Mon D, h:mm AM>" (also the Save box placeholder). */
export function defaultWorldName(now = new Date()) {
    const c = ctx();
    const who = c.groupId ? (c.groups?.find?.(g => g.id === c.groupId)?.name ?? 'Group') : (c.name2 || c.chatId || 'Chat');
    const when = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${worldName(chatWorld()?.id ?? activeWorld)} - ${who} - ${when}`;
}
/** Readable folder hint for a generated name: "riverton-desirae-oct-19" (the server adds -2, -3... if taken). */
const autoIdHint = (now = new Date()) => { const c = ctx(); return [worldName(chatWorld()?.id ?? activeWorld), c.name2 || 'chat', now.toLocaleString('en-US', { month: 'short' }), now.getDate()].map(slug).filter(Boolean).join('-'); };
/**
 * Save box placeholder (= what a blank save uses): on a living save, that world's own name (blank = save over it);
 * on a pristine world, a generated "<base> - <character> - <date>" name. Typing a new name branches a copy.
 */
function refreshSaveName() {
    const i = document.getElementById('worldscrawl_save_name');
    if (!i) return;
    const cur = chatWorld()?.id ?? activeWorld ?? '';
    const id = cur || defaultWorldId;
    placeholderAuto = !worldLiving.get(id);
    i.placeholder = placeholderAuto ? defaultWorldName() : worldName(id);
}
/**
 * Render this chat (its world + its changes) into a new world folder. With switchChat, stamp a rebase on the
 * latest message: from then on the chat is built on the new world and only changes stamped after it are replayed.
 */
// Overridable for tests.
export const hooks = { confirm: async text => { const c = ctx(); return !!c.callGenericPopup && await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM) === c.POPUP_RESULT.AFFIRMATIVE; } };

export async function saveWorld(name, switchChat = true, withKnowledge = false, { overwrite = false, confirm = false } = {}) {
    syncWorld();
    if (!worldNames.size) rememberWorlds((await api('/worlds').catch(() => null))?.body);
    name = String(name ?? '').trim();
    const cur = activeWorld || defaultWorldId;
    if (!name) name = worldLiving.get(cur) ? worldName(cur) : defaultWorldName(); // same rule as the placeholder
    const auto = !worldLiving.get(cur) && (name === defaultWorldName() || (name === document.getElementById('worldscrawl_save_name')?.placeholder && placeholderAuto));
    let knowledge = null;
    if (!(await loadCalendar())) { const e = 'Not saved: the game clock (calendar.mjs) could not be loaded.'; toastr.error(e); return { ok: false, error: e }; }
    if (withKnowledge) { // what this chat knows, for new chats on the saved world (written to knowledge.json)
        const here = await currentLocation();
        const stood = [...await stoodInAddresses()];
        const seen = [...(await discoveredPlaces()).keys()].filter(a => !stood.includes(a));
        knowledge = { location: here.address, stood, seen, doors: [...await syncDoors()] };
    }
    const body = { base: activeWorld || null, name, auto, elapsed: chatElapsed(), ...(auto ? { id_hint: autoIdHint() } : {}), ...mapCtx(), ...(knowledge ? { knowledge } : {}) };
    let r = await api('/worlds/render', { method: 'POST', body: JSON.stringify({ ...body, overwrite }) });
    if (!r.ok && r.body?.detail?.error === 'needs_overwrite') {
        // Name of ANOTHER living world: the panel asks; /ws-save-world needs overwrite=true.
        const other = r.body.detail.name;
        const yes = confirm && await hooks.confirm(`Save over the world "${other}"? Its current version is kept as the one backup.`);
        if (!yes) {
            const e = confirm ? 'Not saved.' : `A world named "${other}" already exists. Add overwrite=true to save over it.`;
            (confirm ? toastr.info : toastr.warning)(e); return { ok: false, error: e };
        }
        r = await api('/worlds/render', { method: 'POST', body: JSON.stringify({ ...body, overwrite: true }) });
    }
    if (!r.ok) { const e = typeof r.body?.detail === 'string' ? r.body.detail : r.body?.detail?.message ?? r.body?.detail?.error ?? `Save failed (${r.status})`; toastr.error(e); return { ok: false, error: e }; }
    worldNames.set(r.body.id, r.body.name); worldLiving.set(r.body.id, !!r.body.living);
    if (r.body.start_date) worldTimes.set(r.body.id, { calendar: r.body.calendar, start_date: r.body.start_date, weather: r.body.weather });
    // Saved over the world this chat is on: always rebase here, or changes since the last switch would be replayed twice.
    const overSelf = !!r.body.overwritten && r.body.id === cur;
    if (overSelf) switchChat = true;
    if (r.body.overwritten) { for (const k of [...exitsCache.keys()]) if (k.startsWith(`${r.body.id}|`)) exitsCache.delete(k); doorInfo.clear(); doorFetched.clear(); }
    // A system message records the save; with switch on it carries the rebase stamp (delete it to go back).
    const c = ctx();
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'saved' },
        mes: overSelf ? `[Engine: world "${r.body.name}" saved over its previous version.]` : `[Engine: world saved as "${r.body.name}"${r.body.overwritten ? ' (over its previous version)' : ''}.${switchChat ? ' This chat now uses it.' : ''}]` };
    c.chat.push(msg);
    if (switchChat) { lastSyncChat = null; msg.extra[WORLD_KEY] = { id: r.body.id, name: r.body.name, version: r.body.map_version, rebase: true, at: c.chat.length - 1, from: activeWorld || null }; }
    c.addOneMessage(msg);
    await c.saveChat();
    if (switchChat) { syncWorld(); renderAllExits(); }
    refreshSaveName();
    toastr.success(`Saved world "${r.body.name}"${switchChat ? '; this chat now uses it' : ''}.`);
    return { ok: true, world: r.body };
}

/** Rebuild everything from this chat's stamps (same as on chat load). */
async function rebuildFromChat() {
    if (!isOn()) return;
    pendingLocation = null;
    // Resolve the chat's world BEFORE any room request: learn the default world, stamp a new chat's world from the
    // current setting (read fresh), then fetch.
    rememberWorlds((await api('/worlds').catch(() => null))?.body); // also rescans the server's worlds folder
    const cw = chatWorld()?.id;
    if (cw && listedWorlds.size && !listedWorlds.has(cw)) worldMissing(cw);
    await ensureStartStamp();
    syncWorld();
    if (ctx().chat?.length) await warmRooms(chatAddresses()); // one request for every room this chat needs (none if all remembered)
    await applyFacts(); setTimeout(renderAllExits, 0);
}
/** Entry in SillyTavern's Extensions (wand) menu that toggles the current chat; its text follows the state. */
export const wandText = () => (isOn() ? 'Disable WorldScrawl for this chat' : 'Enable WorldScrawl for this chat');
function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('worldscrawl_wand')) return;
    const item = document.createElement('div');
    item.id = 'worldscrawl_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-map extensionsMenuExtensionButton"></div><span></span>';
    item.addEventListener('click', () => setEnabled(!isOn()));
    menu.appendChild(item);
    updateWandItem();
}
function updateWandItem() { const t = document.querySelector('#worldscrawl_wand span'); if (t) t.textContent = wandText(); }
/** Apply this chat's on/off state: off clears every injection and footer; on rebuilds exactly as on chat load. */
async function applyChatState() {
    const box = document.getElementById('worldscrawl_enabled'); if (box) box.checked = isOn();
    updateWandItem(); refreshSaveName();
    applyTools(); applyNudge();
    if (!isOn()) { const c = ctx(); for (const [k, d] of [[NUDGE_KEY, 1], [FACTS_KEY, 1], [REMINDER_KEY, 0]]) c.setExtensionPrompt(k, '', 1, d, false, 0); await renderAllExits(); }
    else await rebuildFromChat();
}
/** Turn WorldScrawl on/off for the current chat (saved in its metadata), without reloading. */
export async function setEnabled(on) {
    const c = ctx();
    if (c.chatMetadata) { c.chatMetadata[ENABLED_KEY] = !!on; (c.saveMetadataDebounced ?? c.saveMetadata)?.(); }
    await applyChatState();
    return on ? 'WorldScrawl is on in this chat.' : 'WorldScrawl is off in this chat.';
}
const whenOn = fn => async (...a) => { if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; } return fn(...a); };

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-go',
        callback: whenOn((_args, dir) => goAction(String(dir ?? '').trim())),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction, e.g. north', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: move through an exit or to a known place, then the model narrates the arrival.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-change',
        callback: whenOn(async (_args, note) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && chat[id]?.is_system && !chat[id]?.extra?.worldscrawl_notice) id--;
            const t = await flagMessage(id, { note: String(note ?? '').trim(), source: 'command' });
            toastr.info(`WorldScrawl: ${t}`); return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'what changed, e.g. "the inn burned down" (optional)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: 'WorldScrawl: the map changed in the latest message (fire, collapse, smashed door...). The engine works out the change and shows an Approve / Discard card.',
    }));
    for (const sleep of [false, true]) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: sleep ? 'ws-sleep' : 'ws-wait',
        callback: async (_n, arg) => waitCommand(String(arg ?? ''), sleep),
        helpString: sleep ? 'WorldScrawl: sleep here (default 8h): /ws-sleep, /ws-sleep 6h, /ws-sleep until morning. Time passes without moving; delete the message to undo.'
            : 'WorldScrawl: wait here: /ws-wait 2h, /ws-wait 1h30m, /ws-wait 2d, /ws-wait until dawn|morning|noon|dusk|evening|night|midnight|14:30. Delete the message to undo.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'how long, or "until <time>"', typeList: [ARGUMENT_TYPE.STRING], isRequired: !sleep })],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-help', callback: async () => { await addNotice({ kind: 'text', text: helpText() }); return ''; }, helpString: 'WorldScrawl: list the commands ([move], [look], ... and their slash commands). Answered here; the narrator is not called.' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-npc',
        callback: whenOn(async (_a, name) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && chat[id]?.is_system) id--;
            const msg = chat[id];
            if (!msg) { toastr.info('WorldScrawl: open a chat first.'); return ''; }
            await offerRemember(msg, String(name ?? ''));
            return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'the person to remember, e.g. Maren', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: 'WorldScrawl: remember a person (no name: the person the narrator flagged most recently) from the story (an Approve / Adjust / Discard card). A no lasts until the scene changes.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-know',
        callback: whenOn(async (_a, arg) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && !chat[id]?.is_user) id--;
            const msg = chat[id];
            if (!msg?.is_user) { toastr.info('WorldScrawl: send a message first.'); return ''; }
            const r = await setRelOn(msg, String(arg ?? ''));
            if (!r.ok) { await addNotice({ kind: 'text', text: r.reason }); return ''; }
            toastr.info(`WorldScrawl: ${r.name}: ${r.state}.`);
            renderPatchCards();
            return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'who and how well, e.g. Hesk | met', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: set how well you and a saved person know each other: unmet, met or named. The only way to move it back.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-name',
        callback: whenOn(async (_a, name) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && !chat[id]?.is_user) id--;
            const msg = chat[id];
            if (!msg?.is_user) { toastr.info('WorldScrawl: say it in a message, e.g. [name] Hesk'); return ''; }
            const r = await learnNameOn(msg, String(name ?? ''));
            if (!r.ok) { await addNotice({ kind: 'text', text: r.reason }); return ''; }
            toastr.info(`WorldScrawl: you know ${r.name}'s name now.`);
            renderPatchCards();
            return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'the person whose name you learned, e.g. Hesk', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: you know this person\'s name from now on (the same stamp as [ws_flag: name | Name]). Delete the message to undo.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-found',
        callback: whenOn(async (_a, name) => {
            const chat = ctx().chat ?? [];
            let id = chat.length - 1;
            while (id > 0 && !chat[id]?.is_user) id--;
            const msg = chat[id];
            if (!msg?.is_user) { toastr.info('WorldScrawl: say it in a message, e.g. [found] Hesk'); return ''; }
            await applyFound(msg, [String(name ?? '')], 'bracket');
            renderPatchCards();
            return '';
        }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'the person you found, e.g. Hesk', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: you found someone who is off the map, in this room, when this room is within their "near". Delete the message to undo.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-map', callback: async () => { openMapWindow(); return ''; }, helpString: 'WorldScrawl: open the map window (a new tab that follows this chat live).' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-on', callback: async () => { const t = await setEnabled(true); toastr.info(t); return t; }, helpString: 'WorldScrawl: turn WorldScrawl on in this chat.' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'ws-off', callback: async () => { const t = await setEnabled(false); toastr.info(t); return t; }, helpString: 'WorldScrawl: turn WorldScrawl off in this chat (as if uninstalled; nothing already stamped is changed).' }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-dig', callback: whenOn((a, v) => digAction(String(v ?? ''), { oneway: String(a?.oneway ?? 'false') === 'true' })),
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'oneway', description: 'only the exit from here, no way back (default false)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' })],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'dir[/returndir] and a known place, or "new <name>[: description]", e.g. north Village Square, hole/back new Dusty Cellar', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: open a new two-way passage from the current room to a known place or a new room (return name: the opposite direction, else "back"; oneway=true for one-way). Delete the system message to undo.',
    }));
    for (const kind of ['open', 'close']) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: `ws-${kind}`, callback: whenOn((_a, v) => doorAction(kind, String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: `WorldScrawl: ${kind} a door here (both sides; delete the system message to undo).`,
    }));
    for (const kind of ['bar', 'unbar']) SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: `ws-${kind}`, callback: whenOn((_a, v) => barAction(kind, String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction (optional when there is one barred door here)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: `WorldScrawl: ${kind} a door from the side its bar is on (delete the system message to undo).`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-removeexit', callback: whenOn((_a, v) => removeExitAction(String(v ?? ''))),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: remove an exit from the current room (delete the system message to undo).',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-save-world',
        callback: whenOn(async (args, v) => {
            let name = String(v ?? '');
            const flag = /(^|\s)--knowledge(\s|$)/.test(name);
            name = name.replace(/(^|\s)--knowledge(?=\s|$)/g, ' ').trim();
            const r = await saveWorld(name, String(args?.switch ?? 'true') !== 'false', flag || String(args?.knowledge ?? 'false') === 'true', { overwrite: String(args?.overwrite ?? 'false') === 'true' });
            return r.ok ? r.world.id : '';
        }),
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'overwrite', description: 'save over another existing living world with this name (default false)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            SlashCommandNamedArgument.fromProps({ name: 'knowledge', description: 'also save what this chat knows (places, revealed doors, location) for new chats; default false (pristine)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),SlashCommandNamedArgument.fromProps({ name: 'switch', description: 'move this chat onto the new world (default true)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'true' })],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'world name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: save this chat\'s world (with its dug/removed exits) as a new world; switch=false keeps the chat on its current world; --knowledge (or knowledge=true) also saves what this chat knows.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-exits',
        callback: whenOn(async () => { try { const t = exitsText(await currentLocation()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        helpString: 'WorldScrawl: show the exits from the current location.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-reveal',
        callback: whenOn(async (_args, what) => { try { const t = await revealPlaces(String(what ?? '').trim()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'all | region | subregion | <place, subregion or region id> | off', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: mark places as visited so you can travel there: all (the whole world), region or subregion (the current one), or an id. "off" turns the latest reveal off. Stamped on a small message (delete it to undo).',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-known',
        callback: whenOn(async () => { try { const t = await knownText(); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } }),
        helpString: 'WorldScrawl: list the places this chat knows: where you have been, and places seen but not visited.',
    }));
}

const REVEAL_KEY = 'worldscrawl_reveal';
/** Which addresses a /ws-reveal scope covers, out of the effective map's addresses. */
export function revealScope(what, addresses, here) {
    const w = String(what ?? '').trim();
    if (!w) throw new Error('Say what to reveal: all, region, subregion, or an id.');
    const [reg, rest = ''] = String(here ?? '').split(':'), sub = rest.split('/')[0];
    if (w === 'all') return [...addresses];
    if (w === 'region') return addresses.filter(a => a.startsWith(`${reg}:`));
    if (w === 'subregion') return addresses.filter(a => a.startsWith(`${reg}:${sub}/`));
    if (addresses.includes(w)) return [w];
    const pre = w.includes(':') ? `${w}/` : `${w}:`;
    return addresses.filter(a => a.startsWith(pre));
}
/** /ws-reveal: stamp places as been-there (stateless; delete the message or "/ws-reveal off" to undo). */
export async function revealPlaces(what) {
    const c = ctx(), chat = c.chat ?? [];
    if (what === 'off') {
        for (let i = chat.length - 1; i >= 0; i--) { const rv = chat[i]?.extra?.[REVEAL_KEY]; if (rv && rv.off !== true) { rv.off = true; syncSwipeExtra?.(chat[i]); await c.saveChat?.(); await afterReveal(); return `WorldScrawl: turned off the reveal from #${i}.`; } }
        return 'WorldScrawl: no reveal to turn off.';
    }
    const idx = await api('/inspect/index', { method: 'POST', body: JSON.stringify(mapCtx()) });
    if (!idx.ok) throw new Error(`WorldScrawl: couldn't read the map (${idx.status}).`);
    const here = (await currentLocation().catch(() => null))?.address ?? getStoredLocation();
    const addresses = revealScope(what, idx.body.addresses ?? [], here);
    if (!addresses.length) throw new Error(`WorldScrawl: nothing matches "${what}".`);
    const text = `Map: revealed ${addresses.length} place${addresses.length === 1 ? '' : 's'} (${what}).`;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text, extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'reveal', [REVEAL_KEY]: { scope: what, addresses } } };
    chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
    await afterReveal();
    return text;
}
async function afterReveal() { renderAllExits?.(); broadcastMapState(); }
globalThis.worldscrawlReveal = revealPlaces;

/** Read-only summary of this chat's knowledge (hidden-exit destinations never included: discoveredPlaces filters them). */
export async function knownText() {
    const stood = new Set(await stoodInAddresses());
    const known = await discoveredPlaces();
    const name = p => p.display_name || p.name || p.address;
    const been = [...known.values()].filter(p => stood.has(p.address)).map(name);
    const seen = [...known.values()].filter(p => !stood.has(p.address)).map(name);
    return `Been there: ${been.join(', ') || 'nowhere yet'}. Seen: ${seen.join(', ') || 'nothing else'}.`;
}

// ---- The WorldScrawl window (plugin/ui/, served by the plugin). Same origin, so it hears this tab over a
// BroadcastChannel: every state change is posted, and a window that opens asks with 'hello'.
export const MAP_URL = `${PLUGIN_URL}/ui/`;
let mapChannel = null;
let broadcastTimer = null;
export function broadcastMapState() {
    if (typeof BroadcastChannel === 'undefined') return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(async () => {
        try { mapChannel ??= openMapChannel(); mapChannel.postMessage(await mapState()); } catch (e) { console.warn('[WorldScrawl] map broadcast failed', e); }
    }, 150);
}
export function editChangeInTab(id, p, fallback = () => {}) {
    try { mapChannel ??= openMapChannel(); } catch {}
    const w = typeof window !== 'undefined' ? window.open(changeEditUrl(id, p), '_blank') : null;
    if (!w) { toastr.warning('WorldScrawl: the browser blocked the editor tab, so it opens here instead.'); fallback(); }
}
/** /ws-wait and /ws-sleep (and the map's Wait button): post a stamped message, then let the narrator describe it. */
export async function waitCommand(args, sleep = false) {
    const c = ctx();
    if (!isOn()) { toastr.info(OFF_NOTICE); return OFF_NOTICE; }
    if (engineBusy) return 'WorldScrawl: busy.';
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    const w = await planWait(args, sleep);
    if (w.error) { toastr.warning(`WorldScrawl: ${w.error}`); return w.error; }
    engineBusy = true;
    try {
        const who = partyText(), dur = calendarLib.formatDuration(w.seconds);
        const note = waitNote(who, w);
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stampWait(msg, w);
        msg.extra.worldscrawl_engine = true;
        await c.saveChat();
        renderAllExits(); broadcastMapState();
        await narrate(c);
        return '';
    } catch (e) { toastr.error(e.message); return e.message; } finally { engineBusy = false; }
}

const openCarriers = new WeakSet();
(function carrierCss() {
    if (typeof document === 'undefined' || document.getElementById('worldscrawl_carrier_css')) return;
    const st = document.createElement('style'); st.id = 'worldscrawl_carrier_css';
    st.textContent = `${NOTICE_CSS}
#chat .mes.worldscrawl_carrier_mes{padding:2px 10px;min-height:0;overflow:hidden;font-size:0.82em;}
#chat .mes.worldscrawl_carrier_mes .mes_text,#chat .mes.worldscrawl_carrier_mes .avatar,#chat .mes.worldscrawl_carrier_mes .mesIDDisplay,#chat .mes.worldscrawl_carrier_mes .mes_timer,#chat .mes.worldscrawl_carrier_mes .tokenCounterDisplay{display:none;}
#chat .mes.worldscrawl_carrier_mes .worldscrawl_patchcard{margin-top:0!important;padding:2px 6px!important;font-size:1em!important;}
.worldscrawl_carrier>summary{cursor:pointer;opacity:0.85;}
.worldscrawl_carrier>div{margin:2px 0 2px 1em;}`;
    (document.head ?? document.documentElement).append(st);
})();

(function init() {
    settings();
    if (sharedError) { try { toastr.error(sharedError, 'WorldScrawl', { timeOut: 0, extendedTimeOut: 0 }); } catch {} } // also logged by shared.mjs
    applyTools();
    registerSlashCommands();
    const { eventSource, eventTypes } = ctx();
    // ST pushes the tool-call record message into the chat right before this event and saves it right after.
    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, stampLocation);
    // Narrator generations that fail outright leave a 'narrator' failed note on the triggering message.
    let narrGen = null;
    const endNarr = () => { const p = narrGen; narrGen = null; const n = narratorFailure(p); if (n) { const len = ctx().chat?.length ?? 0; const at2 = p.type === 'swipe' ? len - 2 : len - 1; if (at2 >= 0) p.at = at2; noteCall(p.at, n); console.log(`[WorldScrawl] narrator failed on #${p.at}: ${n.reason}`); } };
    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, (type, opts, dry) => { if (narrGen) endNarr(); if (isOn()) { const p = narratorStart(ctx().chat, type, opts, dry); if (p) narrGen = p; } });
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => { if (narrGen) narrGen.stopped = true; });
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => { const p = narrGen; if (p) setTimeout(() => { if (narrGen === p) endNarr(); }, 800); });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => { if (narrGen) narrGen.received = true; });
    try {
        const tz = globalThis.toastr;
        if (tz?.error && !tz.error.__ws) { const orig = tz.error; tz.error = function (msg, title, ...r) { if (narrGen && !narrGen.error) narrGen.error = String([title, msg].filter(Boolean).join(': ')).replace(/<[^>]+>/g, '').slice(0, 160); return orig.call(this, msg, title, ...r); }; tz.error.__ws = true; }
    } catch { /* no toastr */ }
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, id => { stampExpiryReply(Number(id)).catch(e => console.error('[WorldScrawl] expiry stamp', e)); });
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, id => { onReplyForFlags(Number(id)).catch(e => console.error('[WorldScrawl] flag', e)); });
    eventSource.on(eventTypes.CHAT_CHANGED, async () => { pendingLocation = null; expiryPending = null; snapCarriers(); await applyChatState(); });
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, () => { onMessagesDeleted().catch(e => console.error('[WorldScrawl] delete check', e)); });
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => { if (Number(id) === 0 && isOn()) ensureStartStamp().then(() => setTimeout(renderAllExits, 0)); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    for (const ev of ['MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderAllExits, 0));
    }
    for (const ev of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderStartButton, 0));
    }
    addSettingsPanel();
    addWandItem();
    try { mapChannel = openMapChannel(); } catch {}
    applyNudge();
    console.log('[WorldScrawl] loaded');
})();

export { CHANGE_KEY, DEFAULTS, DEFAULT_NUDGE, FACTS_KEY, FLAGHINT_KEY, FLAG_KEY, MOVE_KEY, NOT_RUNNING, NUDGE_KEY, PATCH_KEY, REMINDER_KEY, REVEAL_KEY, TOOL_NAMES, WAITCARD_KEY, WAIT_KEY, WORLD_KEY, activeWorld, addChangeMessage, applyChatState, baseUrl, csrfHeaders, ctx, engineBusy, expiryPending, goTarget, hasExit, lookAction, mapVersion, missingRoomFallback, moveAction, openCarriers, refreshSaveName, roomLabel, toolsOn };
