// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { WAIT_TAG, waitArgs, parseWaitTag, normalizeWsTags, unreadTags } from './words.mjs';
import { DECIDED_KEY, noticeIdOf, markDecided } from './notices.mjs';
import { narratorNote } from './calllog.mjs';
import { render as P } from './shared.mjs';
import { PLAYER, positionOf } from './actors.mjs';
import { NPC_KEY, NPC_WARN_KEY, FOUND_KEY, framesOf, takeNameFlags, takeFoundFlags, lastsMinutes, takeNpcTags, NPC_FLAG_KEY, takeNpcFlags, takeLoreFlags, loreFor, LORE_KEY, alreadyShown, appearanceIntent, effectFields, judgeAppearance, npcAt, claimWarnings } from './npc.mjs';
import { USER_FLAG_NOTE, analyzeFlag, askModel, clip, loadPatchLib, parseJsonAnswer, replyAfter, storyText, suggestStart } from './carriers.mjs';
import { chatChanges, chatElapsed, placeWeatherNow } from './clock.mjs';
import { baseReply, duplicatePlace, gen, nearbyRooms, noteCall } from './dig.mjs';
import { api, currentLocation, ensurePrompts, getStoredLocation } from './doors.mjs';
import { chatKey } from './expiry.mjs';
import { exitsCache, locationAt, renderAllExits } from './footer.mjs';
import { FLAG_KEY, PATCH_KEY, WAIT_KEY, WAITCARD_KEY, broadcastMapState, ctx, isOn, lookAction, moveAction, settings } from './index.js';
import { roomOptions } from './looking.mjs';
import { matchKey, optionLines, stamp } from './movement.mjs';
import { FLAG_TAG, flagActionText, flagToolText, mapCtx, openEditor, openForms, pendingFoundFlags, pendingLoreFlags, pendingNameFlags, pendingNpcFlags, previewOps, swipeOf } from './patches.mjs';
import { APPEAR_KEY, REMEMBER_KEY, addNpcStamp, applyFacts, applyFound, castPack, ensureAppearanceRebuilds, freshPersonExpiries, personExpiryTurn, invalidateAppearance, judgeFoundNow, learnName, listedPeople, loreChain, matchStubLore, maybeSuggest, npcClock, npcDetail, pendingNpc, refreshLivePlaces, renderTokens, requestLore, toolNpcStamp } from './scene.mjs';
import { decideNpc, epochOf, fillCandidate, findStamp, makeOwner } from './owners.mjs';
import { messageKey, pinBaseline, readBaselineMap, reviewFields } from './replay.mjs';
import { trackerExpiryLines } from './npcexpiry.mjs';
import { capFirst, findPerson, maskForModel, shownName } from './names.mjs';
import { REWRITE_NOT_JUDGED, judgeRewrite } from './arearewrite.mjs';
import { TRACKED_KEY, TRACKER_SOURCE, bumpTracker, hasTrackerCard, markTracked, markTracking, dropTrackerMarks, gateTracker, newSwipePending, playerLineBefore, readTrackerAnswer, shouldTrackReply, trackerGen, trackerPeopleLines, trackerPrompt, trackerScrap, trackerSys } from './tracker.mjs';
import { MIN_NARRATOR_WAIT, narratorWaitAction, noteShortWait, planWait, proposeWait, renderPatchCards, stampWait, waitAsk } from './waits.mjs';

/** Movement tools follow moveMode. ws_flag, ws_wait, and ws_npc are not narrator tools; the after-reply tracker reports changes. */
export function toolsToRegister(s = {}, on = true) {
    if (!on) return [];
    const names = [];
    if (s.moveMode === 'tools') names.push('ws_look', 'ws_move');
    return names;
}

function registerTools(want) {
    const { registerFunctionTool } = ctx();
    const use = name => !want || want.has(name);
    if (use('ws_look')) registerFunctionTool({
        name: 'ws_look',
        displayName: 'WorldScrawl: Look',
        description: 'Get the characters\' current location in the world map: its name, description and the exits leading out of it. Use this before describing where the characters are or where they can go.',
        parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {}, required: [] },
        action: lookAction,
        formatMessage: () => 'Looking around...',
    });
    if (use('ws_move')) registerFunctionTool({
        name: 'ws_move',
        displayName: 'WorldScrawl: Move',
        description: 'Move the characters through one of the current location\'s exits when the characters travel there. Returns the new location. If the direction is not valid, returns an error with the valid directions.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { direction: { type: 'string', description: 'The exit direction exactly as listed by ws_look, e.g. "north" or "out".' } },
            required: ['direction'],
        },
        action: moveAction,
        formatMessage: ({ direction } = {}) => `Moving ${direction ?? ''}...`,
    });
    if (use('ws_flag')) registerFunctionTool({
        name: 'ws_flag',
        displayName: 'WorldScrawl: Flag a map change',
        description: flagToolText(),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { action: { type: 'string', enum: ['change', 'discover', 'wait', 'sleep', 'npc', 'name', 'lore', 'found'], description: flagActionText() },
                location: { type: 'string', description: 'The place that changed (its name); for "lore", the place whose lore you want.' }, note: { type: 'string', description: 'For "change": a few words on what changed, e.g. "the inn burned down". For "wait"/"sleep": how long, e.g. "2h", "1h30m", "until morning", "until 14:00".' } },
            required: ['note'],
        },
        action: async ({ action = 'change', location = '', note = '' } = {}) => {
            if (action === 'wait' || action === 'sleep') {
                const tg = parseWaitTag(String(note ?? ''));
                const w = await planWait(tg.args, action === 'sleep' || tg.sleep, tg.reason);
                if (w.error) return `Could not pass time: ${w.error}`;
                if (!(w.seconds >= MIN_NARRATOR_WAIT)) { noteShortWait(w); return 'Under 15 minutes: no time is added to the clock.'; } pendingWait = w; return `Time passes: ${w.label}. It will then be ${w.afterText}.${waitAsk()}`;
            }
            if (action === 'lore') {
                const loc = await currentLocation(), chain = loreChain(loc);
                let hits = loreFor(chain, String(location || note || ''));
                const asked = String(location || note || '').trim();
                if (!hits.length) { const stub = matchStubLore(asked); if (stub) hits = [{ level: 'elsewhere', id: stub.id, name: stub.name, text: stub.lore }]; }
                const person = !hits.length && asked ? findPerson(asked, [...(framesOf(ctx().chat ?? [], (ctx().chat ?? []).length - 1, castPack()?.npcs ?? []).at(-1)?.values() ?? [])]) : null;
                if (person?.deep?.history) { pendingLoreFlags.push(asked); return renderTokens(`${capFirst(shownName(person))}'s history: ${person.deep.history}`); }
                if (!hits.length) return chain.length ? `No lore on file for that. Lore on file: ${chain.map(c => c.name).join(', ')}.` : 'No lore on file here.';
                pendingLoreFlags.push(...hits.map(h => h.name));
                return renderTokens(P('narration.lore_block', { lore: hits.map(c => `- ${c.name}: ${c.text}`).join('\n') }));
            }
            if (action === 'name') { const n = String(note || location || '').trim().slice(0, 60); if (n) pendingNameFlags.push(n); return 'Noted.'; }
            if (action === 'found') {
                const n = String(note || location || '').trim().slice(0, 80);
                if (!n) return 'Say who was found.';
                pendingFoundFlags.push(n);
                const j = await judgeFoundNow(n);
                return j.reason;
            }
            if (action === 'npc') { const n = String(note || location || '').trim().slice(0, 60); if (n) pendingNpcFlags.push(n); return 'Noted.'; }
            if (action === 'discover') { pendingFlag = { kind: 'discover', hint: String(location ?? ''), note: String(note ?? '').slice(0, 200), source: 'tool' }; return 'Noted. The engine will add the room behind that door after your reply.'; }
            pendingFlag = { hint: String(location ?? ''), note: String(note ?? '').slice(0, 200), source: 'tool' }; return 'Noted. The engine will review the map change after your reply.'; },
        formatMessage: ({ action } = {}) => action === 'wait' || action === 'sleep' ? 'Passing time...' : 'Noting a map change...',
    });
    if (use('ws_wait')) registerFunctionTool({
        name: 'ws_wait',
        displayName: 'WorldScrawl: Wait or sleep',
        description: P('narration.wait_tool'),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { duration: { type: 'string', description: 'How long, e.g. "2h", "1h30m", "2d".' },
                until: { type: 'string', description: 'Instead of a duration: wait until dawn, morning, noon, dusk, evening, night, midnight, or a time like "14:00".' },
                sleep: { type: 'boolean', description: 'true if they sleep (default 8h when no duration or until is given).' },
                reason: { type: 'string', description: 'Optional: a few words on what takes the time, e.g. "searching the cellar".' } },
            required: [],
        },
        action: async ({ duration = '', until = '', sleep = false, reason = '' } = {}) => {
            const w = await planWait(waitArgs({ duration, until }), sleep === true || sleep === 'true', reason);
            if (w.error) return `Could not pass time: ${w.error}`;
            if (!(w.seconds >= MIN_NARRATOR_WAIT)) { noteShortWait(w); return 'Under 15 minutes: no time is added to the clock.'; } pendingWait = w; return `Time passes: ${w.label}. It is now ${w.afterText}.${waitAsk()}`;
        },
        formatMessage: ({ sleep } = {}) => (sleep ? 'Sleeping...' : 'Waiting...'),
    });
    if (use('ws_npc')) registerFunctionTool({
        name: 'ws_npc',
        displayName: 'WorldScrawl: A person here',
        description: P('narration.npc_tool'),
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#', type: 'object',
            properties: {
                action: { type: 'string', description: 'fact, memory, disposition, appearance, leave, staying, follow, stay, seek, or detail.' },
                id: { type: 'string', description: 'The person\'s id from the people-here list.' },
                text: { type: 'string', description: 'The fact; the memory note (short, from their point of view: something they would still remember tomorrow); or what detail is needed.' },
                value: { type: 'string', enum: ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'], description: 'For disposition: their attitude toward the player now: hostile, unfriendly, indifferent, friendly, or helpful.' },
                reason: { type: 'string', description: 'For disposition: a few words on why their attitude toward the player changed.' },
                lasts: { type: 'string', description: 'For fact or appearance: how long it lasts in game time (e.g. "2 hours", "3 days") when it is temporary. Leave out for a lasting change.' },
                intent: { type: 'string', description: 'For appearance: what actually changed in Looks, Body or Outfit (e.g. "magically young", "soaked from the rain"). Not "looks" or "appeared", and not because they entered or were looked at.' },
                fields: { type: 'string', description: 'For appearance: which of looks, body, outfit changed (comma-separated). Omit or "all" when a full rewrite.' },
                scope: { type: 'string', enum: ['light', 'heavy'], description: 'For appearance: light when one detail changes and the rest still fits; heavy when the change remakes them (a transformation, a whole new outfit).' },
                why: { type: 'string', description: 'For appearance: a few words on why that scope.' },
                looks: { type: 'string', description: 'For appearance: optional. Prefer intent/fields/lasts only; Looks is rebuilt for you.' },
                body: { type: 'string', description: 'For appearance: optional. Prefer intent/fields/lasts only; Body is rebuilt for you.' },
                outfit: { type: 'string', description: 'For appearance: optional. Prefer intent/fields/lasts only; Outfit is rebuilt for you.' },
            },
            required: ['action', 'id'],
        },
        action: async (args = {}) => {
            if (String(args.action ?? '').toLowerCase() === 'detail') return npcDetail(String(args.id ?? ''));
            const stamp = toolNpcStamp(args);
            if (!stamp) return 'Nothing to record.';
            pendingNpc.push(stamp);
            return 'Noted. It will be kept on this reply.';
        },
        formatMessage: () => 'Noting a person...',
    });
}
let pendingWait = null; // places from ws_flag action lore: stamped on the reply when it arrives
let pendingFlag = null;
let pendingUserFlag = null;

// ---- Discovery rooms: a door that the room description only mentions (set dressing) is opened in the story, and the
// room behind it is added as if it had always been there: one story-made create_place (a new room with an engine-made
// id and one door pair; ). No lore, no rewrite of the room it opens from. Stamped at once unless "review discoveries" is on.
export const discoverSys = () => P('discover.system', { reply: baseReply('json'), style: P('discover.style') });
export const discoverPrompt = (k, { exits, near, story, start, id, note, err, existing = [] }) => P('discover.question', { existing: existing.length ? P('discover.existing', { places: optionLines(existing) }) : '', region_name: k.region_name, region_notes: k.region_notes, area_name: k.area_name, area_notes: k.area_notes,
    name: k.name, address: k.location, description: k.description, exits, near, start, end: id, story, door: note ? P('discover.door', { note: clip(note, 200) }) + '\n' : '', retry: err ? P('discover.retry', { error: err }) + '\n' : '' });
/** A discovery answer naming an existing place: one door pair (add_exit) to it. null when the answer is a new room. */
export function existingDiscovery(a, existing, from) {
    if (a?.existing == null || a.existing === '') return null;
    const key = matchKey(String(a.existing), existing.map(o => o.key));
    if (key == null) return { error: `"existing" must be one of the place keys: ${existing.map(o => o.key).join(', ') || '(none): describe a new room'}` };
    const t = x => (typeof a[x] === 'string' && a[x].trim() ? a[x].trim() : undefined);
    if (!t('direction')) return { error: '"direction" is needed' };
    return { op: { op: 'add_exit', loc: from, to: existing.find(o => o.key === key).room.address, direction: t('direction'), return_direction: t('return_direction') ?? 'out', door: true, description: t('exit_description'), return_description: t('return_description') } };
}
async function analyzeDiscovery(id) {
    await ensurePrompts();
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], f = msg?.extra?.[FLAG_KEY];
    if (f.start == null || f.start === '' || !Number.isFinite(Number(f.start))) f.start = suggestStart(chat, id, f.loc);
    f.status = 'working'; f.error = ''; delete f.proposal;
    renderPatchCards();
    try {
        const r0 = await api('/discover/context', { method: 'POST', body: JSON.stringify({ location: f.loc, ...mapCtx() }) });
        if (!r0.ok) throw new Error(r0.body?.detail?.error ?? r0.body?.detail ?? `map server answered ${r0.status}`);
        const k = r0.body;
        if (!k.expandable) { f.status = 'error'; f.error = `${k.name} can't have new rooms (it is marked "expandable": false).`; return; }
        const exits = k.exits.map(x => `${x.direction} -> ${x.to}${x.description ? `: ${x.description}` : ''}`).join('\n') || 'none';
        const near = k.neighbors.map(n => `${n.name} (${n.address}): ${clip(n.description, 300)}`).join('\n') || 'none'; // name-ok: place names
        const story = clip(storyText(chat, f.start, id), 4000);
        // Places nearby that are not connected here yet: the door may lead to one of them instead of a new room.
        const linked = new Set([k.location, ...k.neighbors.map(n => n.address), ...k.exits.map(x => x.to)]);
        const nearAll = await nearbyRooms({ address: k.location });
        const existing = roomOptions(nearAll.filter(r => !linked.has(r.address)));
        const q = err => discoverPrompt(k, { exits, near, story, start: f.start, id, note: f.note, err, existing });
        let preview = null, ops = null, err = '';
        for (let tries = 0; tries < 2 && !preview; tries++) {
            const a = parseJsonAnswer(await askModel(c, 'discovery', { prompt: q(err), systemPrompt: discoverSys(), responseLength: 500 }));
            if (!a || typeof a !== 'object') { err = 'the answer was not JSON'; continue; }
            let ex = existingDiscovery(a, existing, k.location);
            if (ex?.error) { err = ex.error; continue; }
            const dup = !ex && typeof a.name === 'string' ? duplicatePlace(a.name, [...nearAll, ...k.neighbors.map(n => ({ address: n.address, name: n.name, steps: 1 }))], { not: [k.location] }) : null; // name-ok: place names
            if (dup && linked.has(dup.address)) { f.status = 'nothing'; f.error = `${dup.name} is already connected here, so no new room was added`; return; }
            if (dup) { const o = existing.find(e => e.room.address === dup.address); if (o) { ex = existingDiscovery({ ...a, existing: o.key }, existing, k.location); if (ex?.error) ex = null; else console.log(`[WorldScrawl] discovery: "${a.name}" is ${dup.name}, already on the map: connecting it`); } }
            // The same create_place the editor and the change call use (engine-made id, one door pair back to this room).
            ops = ex ? [ex.op] : [(await loadPatchLib()).discoverToCreate({ loc: k.location, ...Object.fromEntries(['name', 'description', 'direction', 'return_direction', 'exit_description', 'return_description'].filter(x => typeof a[x] === 'string' && a[x].trim()).map(x => [x, a[x].trim()])) })];
            const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops }, ...mapCtx() }) });
            if (r.ok) { preview = r.body; ops = r.body.ops ?? ops; } else err = r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status);
        }
        if (!preview) { f.status = 'error'; f.error = `The new room didn't fit the map: ${err}`; return; }
        f.note = f.note || clip(preview.summary[0], 120);
        f.proposal = { ops, summary: preview.summary, relocate: preview.relocate ?? {}, inherit: preview.inherit ?? {}, names: preview.names ?? {}, before: preview.before, after: preview.after };
        f.status = 'review';
        await keepFlag(id, { quiet: true }); // a discovery is added at once; its 'Map changed here' bar offers Edit / Turn off / Undo
    } catch (e) {
        f.status = 'error'; f.error = e.message;
    } finally {
        await c.saveChat?.();
        renderPatchCards();
        broadcastMapState();
    }
}

/**
 * The duplicate-room guard's "Make it a new room instead": drop the merge and put back the change's own create_place
 * ops (checked by the same preview), so a separate new room is made. Returns '' or the reason it could not.
 */
export async function unmergeFlag(id) {
    const c = ctx(), msg = c.chat?.[id], f = msg?.extra?.[FLAG_KEY], pr = f?.proposal;
    if (!pr?.unmerged?.length) return 'nothing was merged';
    const r = await api('/patch/preview', { method: 'POST', body: JSON.stringify({ patch: { ops: pr.unmerged }, ...mapCtx() }) });
    if (!r.ok) { const e = r.body?.detail?.error ?? JSON.stringify(r.body?.detail ?? r.status); toastr.warning(`WorldScrawl: the new room didn't fit the map: ${e}`); return e; }
    const b = r.body;
    f.proposal = { ops: b.ops ?? pr.unmerged, summary: [...b.summary, ...pr.merged.map(m => `Added as a new room "${m.name}" (not ${m.to_name}, which is ${m.steps} step${m.steps === 1 ? '' : 's'} away).`)], relocate: b.relocate, inherit: b.inherit ?? {}, names: b.names ?? {}, before: b.before, after: b.after, newRoom: pr.merged.map(m => m.name) };
    openForms.delete(`${id}|flag`);
    noteCall(id, { kind: 'duplicate-room guard', status: 'ok', reason: `player chose a new room instead of ${pr.merged.map(m => m.to_name).join(', ')}` });
    await c.saveChat?.(); renderPatchCards();
    return '';
}

/**
 * Flag message `id` as the place where a map change settled, and start the review. The one door for every trigger
 * (button, tool, tag, /ws-change, and future engine actions): opts {note, hint, start, source}.
 */
export async function flagMessage(id, { note = '', hint = '', start = null, source = 'button', kind = '', rewrite = '', why = '', raw = null } = {}) {
    if (!isOn()) return 'WorldScrawl is off in this chat.';
    const c = ctx(), chat = c.chat ?? [];
    id = Number(id);
    const msg = chat[id];
    if (!msg || (msg.is_system && !msg.extra?.worldscrawl_notice)) return 'Pick a story message to flag.';
    msg.extra = msg.extra ?? {};
    if (msg.is_user && source === 'button') { // the change call reads the story up to the narrator's reply: flag that reply, from this message on
        const r = replyAfter(chat, id);
        if (r >= 0) return flagMessage(r, { note, hint, start: id, source, kind });
        msg.extra[FLAG_KEY] = { swipe: swipeOf(msg), loc: locationAt(id) ?? null, source, start: id, status: 'user' };
        pendingUserFlag = { chat: chatKey(), start: id, note, hint };
        renderPatchCards();
        return USER_FLAG_NOTE;
    }
    let loc = null, err = '';
    try { await loadPatchLib(); loc = locationAt(id) ?? (await currentLocation())?.address ?? null; } catch (e) { console.error('[WorldScrawl] map flag', e); err = e?.message || String(e); }
    msg.extra[FLAG_KEY] = { swipe: swipeOf(msg), loc, note: clip(note, 200), hint: clip(hint, 80), source, start: start ?? suggestStart(chat, id, loc), status: err ? 'error' : 'working', ...(err ? { error: err } : {}), ...(kind === 'discover' ? { kind } : flagRewrite(source, rewrite, why)), ...(raw && source === TRACKER_SOURCE ? { trackerPlace: raw } : {}) };
    try { await c.saveChat?.(); } catch (e) { console.error('[WorldScrawl] save', e); }
    if (err) { renderPatchCards(); return `Map change failed: ${err}`; }
    analyzeFlag(id).catch(e => { const f = msg.extra?.[FLAG_KEY]; if (f) { f.status = 'error'; f.error = e?.message || String(e); } console.error('[WorldScrawl] map flag', e); renderPatchCards(); });
    return kind === 'discover' ? 'Adding the room behind that door…' : 'Checking what changed on the map…';
}
globalThis.worldscrawlFlag = flagMessage;
/** Light touch or full rewrite for a new place flag: the tracker's pick, else light. A tracker answer without a clear one
 *  says it was not judged (the change is still made as a light touch, the default, and the switch offers a full rewrite);
 *  a flag the player or narrator raised (button, /ws-change, tag, tool) is a plain light touch. */
function flagRewrite(source, rewrite, why) {
    const j = judgeRewrite(rewrite, why);
    if (j.rewrite) return { rewrite: j.rewrite, ...(j.why ? { why: clip(j.why, 200) } : {}) };
    return { rewrite: 'light', ...(source === TRACKER_SOURCE ? { why: REWRITE_NOT_JUDGED } : {}) };
}

/** Keep: stamp the proposed patch on the message (the only thing that changes the map). */
async function keepFlag(id, { quiet = false } = {}) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[id], f = msg?.extra?.[FLAG_KEY];
    if (!f?.proposal) return;
    const form = openForms.get(`${id}|flag`);
    if (f.proposal.invalid && !form) { openEditor(`${id}|flag`, f.proposal.ops, { loc: f.loc ?? getStoredLocation() ?? '' }); return; } // fix it in the editor first
    if (form) {
        const ops = form.getOps();
        if (!ops.length) { form.setErrors([{ i: null, error: 'Nothing to keep: add a change, or press Discard.' }]); return; }
        const r = await previewOps(ops, { changes: chatChanges(chat.slice(0, id + 1)), now: chatElapsed(chat.slice(0, id + 1)) });
        if (!r.ok) { form.setErrors(r.errors); return; }
        f.proposal = { ...f.proposal, ops: r.preview.ops ?? ops, summary: r.preview.summary, relocate: r.preview.relocate ?? {}, inherit: r.preview.inherit ?? {}, names: r.preview.names ?? {} };
        openForms.delete(`${id}|flag`);
    }
    if (!markDecided(msg, noticeIdOf(f, 'flag'), form ? 'adjust' : 'approve', { swipe: swipeOf(msg), text: clip((f.proposal.summary ?? []).join('; '), 160) })) return; // already decided
    const p = { type: 'patch', id: `p_${Date.now().toString(36)}`, note: f.note || clip(f.proposal.summary[0], 120), at: chatElapsed(chat.slice(0, id + 1)),
        ops: f.proposal.ops, relocate: f.proposal.relocate ?? {}, inherit: f.proposal.inherit ?? {}, names: f.proposal.names ?? {}, summary: f.proposal.summary, range: { start: f.start, end: id }, swipe: swipeOf(msg), ...(f.source ? { source: f.source } : {}), ...(f.rewrite ? { rewrite: f.rewrite } : {}) };
    msg.extra[PATCH_KEY] = [...(msg.extra[PATCH_KEY] ?? []), p];
    syncSwipeExtra(msg);
    f.status = 'kept'; f.patch = p.id;
    delete f.proposal.before; delete f.proposal.after;
    await c.saveChat?.();
    exitsCache.clear();
    if (!quiet) toastr.success('WorldScrawl: map changed. Delete this message (or press Undo) to undo it.');
    await applyFacts();
    renderAllExits();
}
/** SillyTavern keeps each swipe's extra in swipe_info: mirror the patches there so swiping away and back keeps them. */
function syncSwipeExtra(msg) {
    const si = msg?.swipe_info?.[swipeOf(msg)];
    if (!si) return;
    si.extra = si.extra ?? {};
    if (msg.extra[PATCH_KEY]) si.extra[PATCH_KEY] = msg.extra[PATCH_KEY]; else delete si.extra[PATCH_KEY];
    if (msg.extra[NPC_KEY]) si.extra[NPC_KEY] = msg.extra[NPC_KEY]; else delete si.extra[NPC_KEY];
    if (msg.extra[NPC_WARN_KEY]) si.extra[NPC_WARN_KEY] = msg.extra[NPC_WARN_KEY]; else delete si.extra[NPC_WARN_KEY];
    if (msg.extra[FOUND_KEY]) si.extra[FOUND_KEY] = msg.extra[FOUND_KEY]; else delete si.extra[FOUND_KEY];
    if (msg.extra[REMEMBER_KEY]) si.extra[REMEMBER_KEY] = msg.extra[REMEMBER_KEY]; else delete si.extra[REMEMBER_KEY];
    if (msg.extra[DECIDED_KEY]) si.extra[DECIDED_KEY] = msg.extra[DECIDED_KEY]; else delete si.extra[DECIDED_KEY];
    if (msg.extra[APPEAR_KEY]) si.extra[APPEAR_KEY] = msg.extra[APPEAR_KEY]; else delete si.extra[APPEAR_KEY];
    if (msg.extra.worldscrawl_compose) si.extra.worldscrawl_compose = msg.extra.worldscrawl_compose; else delete si.extra.worldscrawl_compose;
    if (msg.extra.worldscrawl_npc_baseline) si.extra.worldscrawl_npc_baseline = msg.extra.worldscrawl_npc_baseline;
    if (msg.extra.worldscrawl_mid) si.extra.worldscrawl_mid = msg.extra.worldscrawl_mid;
    if (msg.extra[TRACKED_KEY]) si.extra[TRACKED_KEY] = msg.extra[TRACKED_KEY]; else delete si.extra[TRACKED_KEY];
}
async function undoFlag(id) {
    const c = ctx(), msg = c.chat?.[id], f = msg?.extra?.[FLAG_KEY];
    if (!msg) return;
    msg.extra[PATCH_KEY] = (msg.extra[PATCH_KEY] ?? []).filter(p => p.id !== f?.patch);
    if (!msg.extra[PATCH_KEY].length) delete msg.extra[PATCH_KEY];
    delete msg.extra[FLAG_KEY];
    syncSwipeExtra(msg);
    await c.saveChat?.();
    exitsCache.clear();
    await applyFacts();
    renderAllExits();
}
async function discardFlag(id) {
    const c = ctx(), msg = c.chat?.[id];
    const f0 = msg?.extra?.[FLAG_KEY];
    if (f0?.status === 'review' && f0.proposal && !markDecided(msg, noticeIdOf(f0, 'flag'), 'discard', { swipe: swipeOf(msg), text: clip((f0.proposal.summary ?? []).join('; '), 160) || 'map change' })) return;
    if (msg?.extra) delete msg.extra[FLAG_KEY];
    await c.saveChat?.();
    renderPatchCards();
}

/** The same wait rules a tag uses: short and explicit waits are ignored; otherwise a card, or a stamp when auto-keep is on. */
async function applyProposedWait(id, w, source = '') {
    const c = ctx(), msg = c.chat?.[id];
    if (!msg || !w) return;
    const what = narratorWaitAction(c.chat.slice(0, id), w, !!settings().autoKeepWaits);
    if (what !== 'card' && what !== 'keep') { console.log(`[WorldScrawl] narrator wait ignored (${what}): ${w.label}`); noteCall(id, { kind: `narrator wait ${w.label}`, status: 'skipped', reason: `${what}${w.reason ? `; why: ${w.reason}` : ''}` }); return; }
    if (what === 'keep') {
        noteCall(id, { kind: `narrator wait ${w.label}`, status: 'ok', reason: `kept (Auto-keep waits); why: ${w.reason || '(no reason given)'}` });
        stampWait(msg, w);
        if (source) { msg.extra[WAIT_KEY].source = source; msg.extra[WAIT_KEY].swipe = swipeOf(msg); }
        await c.saveChat?.(); { const host = c.chat.length - 1; await personExpiryTurn(host); await (await import('./placerevert.mjs')).placeExpiryTurn(host); } await applyFacts(); renderAllExits(); broadcastMapState();
    } else {
        noteCall(id, { kind: `narrator wait ${w.label}`, status: 'ok', reason: `proposed; why: ${w.reason || '(no reason given)'}` });
        proposeWait(msg, w);
        if (source && msg.extra?.[WAITCARD_KEY]) msg.extra[WAITCARD_KEY].source = source;
        await c.saveChat?.(); renderPatchCards();
    }
}
/** Today's person apply: no-op appearance (empty, "looks", "appeared") warns and does not stamp or rebuild. */
async function applyPersonStamps(id, stamped) {
    const c = ctx(), msg = c.chat?.[id];
    if (!msg || !stamped?.length) return;
    const clock = npcClock(c.chat, id);
    const folded = [...(framesOf(c.chat, id, castPack()?.npcs ?? []).at(-1)?.values() ?? [])];
    const applied = [];
    const toFill = [];
    const noteNpcWarning = (text, source = '') => {
        msg.extra = msg.extra ?? {};
        const swipe = swipeOf(msg);
        const list = Array.isArray(msg.extra[NPC_WARN_KEY]) ? msg.extra[NPC_WARN_KEY] : [];
        if (list.some(w => w?.text === text && (w?.swipe ?? 0) === swipe && (w?.source ?? '') === source)) return;
        msg.extra[NPC_WARN_KEY] = [...list, { swipe, text, ...(source ? { source } : {}) }];
        noteCall(id, { kind: 'warning', status: 'failed', reason: text });
    };
    for (const s0 of stamped) {
        const warnFrom = s0.source === TRACKER_SOURCE ? TRACKER_SOURCE : '';
        const t = findPerson(s0.id, folded)?.id ?? null;
        if (!t) { noteNpcWarning(`Warning: a person update did not land: no saved person has the id "${s0.id}".`, warnFrom); continue; }
        let s = t === s0.id ? s0 : { ...s0, id: t };
        const cur = folded.find(n => n.id === t) || npcAt(c.chat, id, castPack()?.npcs ?? [], t);
        if (s.type === 'npc_fact' && alreadyShown(cur, s.text)) { noteCall(id, { kind: 'npc_fact', status: 'skipped', reason: 'already known' }); continue; }
        if (s.type === 'npc_appearance') {
            const decision = judgeAppearance(cur, s);
            if (decision === 'skip') { noteCall(id, { kind: 'npc_appearance', status: 'skipped', reason: 'already active' }); continue; }
            if (decision === 'reject') {
                noteNpcWarning(`Warning: a person update for ${cur?.name || t} did not land: appearance did not change.`, warnFrom);
                continue;
            }
            const intent = appearanceIntent(s);
            if (intent && intent !== s.intent) s = { ...s, intent };
            if (s.source === 'tracker') {
                const named = s.fields != null && String(s.fields).trim() !== '';
                let fields = named ? effectFields(s.fields) : ['body', 'outfit'].filter(f => typeof s[f] === 'string' && s[f].trim());
                fields = fields.filter(f => f !== 'looks');
                if (!fields.length) { noteCall(id, { kind: 'npc_appearance', status: 'skipped', reason: 'tracker does not set looks' }); continue; }
                const { looks, ...rest } = s;
                s = { ...rest, fields: fields.join(',') };
            }
            const pin = readBaselineMap(c.chat)[s.id] || pinBaseline(c.chat, s.id, cur?.body ?? '', cur?.outfit ?? '');
            const layer = { ...(s.body ? { body: s.body } : {}), ...(s.outfit ? { outfit: s.outfit } : {}) };
            const namedFields = s.fields != null && String(s.fields).trim() !== '' ? String(s.fields) : '';
            const owner = makeOwner({
                id: s.id, intent: s.intent || '', fields: namedFields || Object.keys(layer).join(',') || 'body,outfit',
                layer,
                lasts: lastsMinutes(s.lasts), start: Number.isFinite(clock.elapsed) ? clock.elapsed : 0,
                scope: s.scope, why: s.why || '',
                chatId: c.chatId ?? c.getCurrentChatId?.() ?? '', message: messageKey(msg), swipe: swipeOf(msg), source: s.source || '',
            });
            owner.candidate.epoch = epochOf(msg);
            addNpcStamp(msg, owner);
            applied.push(owner);
            toFill.push({ owner, pin, name: cur?.name || s.id });
            continue;
        }
        let stamp = s;
        if (s.type === 'npc_fact' && !lastsMinutes(s.lasts)) stamp = { ...s, pending: true };
        if (s.type === 'npc_staying') stamp = { ...s, elapsed: s.elapsed ?? clock.elapsed };
        else if (s.type === 'npc_stay' && !s.place) {
            const place = positionOf(c.chat, id, PLAYER)?.address || '';
            if (place) stamp = { ...s, place };
        }
        addNpcStamp(msg, stamp);
        applied.push(stamp);
    }
    const seen = new Set();
    for (const s of applied) {
        if (s.pending === true || seen.has(s.id)) continue;
        seen.add(s.id);
        const live = npcAt(c.chat, id, castPack()?.npcs ?? [], s.id);
        for (const w of claimWarnings(live, applied.filter(x => x.id === s.id && x.pending !== true))) noteNpcWarning(w, s.source === TRACKER_SOURCE ? TRACKER_SOURCE : '');
    }
    syncSwipeExtra(msg);
    await c.saveChat?.();
    for (const row of toFill) {
        const filled = await fillCandidate(c.chat, row.owner.identity, { baseline: row.pin, name: row.name, elapsed: clock.elapsed }).catch(e => { console.warn('[WorldScrawl] appearance fill', e); return null; }); // name-ok: masked in the owners prompt builder
        if (filled?.ok) dropNoopProposal(c.chat, row.owner.identity, id, row.name); // name-ok: inspector note
    }
    syncSwipeExtra(msg);
    await c.saveChat?.();
}
/**
 * A proposal whose reviewed result is exactly how the person looks now (often the story narrating an expiry the
 * engine already applied) asks the player nothing: it is discarded through decideNpc, then the never-committed
 * stamp is taken off the message, and the call log says why.
 */
function dropNoopProposal(chat, identity, at, name) {
    const found = findStamp(chat, identity);
    const s = found?.stamp, cand = s?.candidate;
    if (!cand || cand.phase !== 'review' || s.committed || reviewFields(cand).length) return false;
    const res = decideNpc(chat, identity, s.decisionRev, 'discard', {});
    if (!res?.ok) return false;
    const list = found.msg.extra?.[NPC_KEY];
    if (Array.isArray(list)) { found.msg.extra[NPC_KEY] = list.filter(x => x !== s); if (!found.msg.extra[NPC_KEY].length) delete found.msg.extra[NPC_KEY]; }
    noteCall(at, { kind: 'npc_appearance', status: 'skipped', reason: `no change: the result matches how ${name || identity.npc} looks now` });
    return true;
}
function trackerPayloads(people) {
    const stamps = [], found = [], names = [];
    for (const p of people ?? []) {
        if (p.action === 'found') { found.push(p.name || p.id); continue; } // name-ok: inbound (tracker answer)
        if (p.action === 'name') { names.push({ id: p.id, name: p.name || '' }); continue; } // name-ok: inbound (tracker answer)
        const stamp = toolNpcStamp({ ...p, id: p.id || p.name }); // name-ok: inbound (tracker answer)
        if (stamp) stamps.push({ ...stamp, source: TRACKER_SOURCE });
    }
    return { stamps, found, names };
}
/** Tracker name items: the item's handle (or id) says who, its name is what was heard. No name-only fallback. */
async function applyLearnedNames(id, learned, source) {
    const c = ctx(), msg = c.chat?.[id];
    if (!msg || !learned?.length) return;
    const done = new Set();
    for (const row of learned) {
        if (!row?.id) { noteCall(id, { kind: 'name learn', status: 'skipped', reason: `${source}: the name item named nobody (no id)` }); continue; }
        if (done.has(row.id)) continue;
        done.add(row.id);
        await learnName(msg, { target: row.id, heard: row.name, source }); // name-ok: inbound (what was heard)
    }
    await c.saveChat?.();
}
/** Feed a tracker answer into the place rewrite and the person apply. No third apply path. */
export async function applyTrackerResult(id, parsed) {
    const c = ctx(), msg = c.chat?.[id];
    if (!msg) return;
    const gated = gateTracker(parsed, { places: settings().flagTags !== false, people: settings().flagNpcs !== false });
    const { stamps, found, names } = trackerPayloads(gated.people);
    if (stamps.length) await applyPersonStamps(id, stamps);
    if (names.length) await applyLearnedNames(id, names, TRACKER_SOURCE);
    if (found.length) await applyFound(msg, found, TRACKER_SOURCE);
    const existing = msg.extra?.[FLAG_KEY];
    const taggedPlace = existing && (existing.swipe ?? 0) === swipeOf(msg) && existing.source !== TRACKER_SOURCE;
    if (gated.place && !taggedPlace) await flagMessage(id, { note: gated.place.note, hint: gated.place.hint ?? '', kind: gated.place.kind === 'discover' ? 'discover' : '', source: TRACKER_SOURCE, rewrite: gated.place.rewrite ?? '', why: gated.place.why ?? '', raw: gated.place.raw ?? null });
    if (gated.wait) {
        const args = gated.wait.until ? `until ${gated.wait.until}` : gated.wait.duration;
        const w = await planWait(args, gated.wait.sleep, gated.wait.reason);
        if (w.error) noteCall(id, { kind: 'tracker wait', status: 'failed', reason: w.error });
        else await applyProposedWait(id, w, TRACKER_SOURCE);
    }
    syncSwipeExtra(msg);
    renderPatchCards();
}
/** Hit 3. A small question, not the narrator, and not the narrator's chat. Story is already on screen. */
async function runTracker(id) {
    if (!isOn()) return;
    const c = ctx(), chat = c.chat ?? [], msg = chat[id];
    if (!shouldTrackReply(msg, chat, id)) return;
    const genNo = bumpTracker(msg);
    const swipe = swipeOf(msg), story = msg.mes ?? '';
    let status = null; // what the marker ends on (null: skipped or stale, nothing shown for this read)
    try {
        await ensurePrompts();
        let loc = null;
        try { loc = await currentLocation(); } catch { loc = null; }
        // Without the place and the cards, a look or an entrance is too easy to mistake for a change.
        if (!loc?.name && !loc?.address) { noteCall(id, { kind: 'tracker', status: 'skipped', reason: 'place unavailable' }); return; }
        markTracking(msg, genNo);
        renderPatchCards();
        const weather = placeWeatherNow(loc)?.line ?? '';
        const people = listedPeople(chat, id, loc);
        const engineLines = trackerExpiryLines(freshPersonExpiries(chat, id));
        // Every line of the scrap is engine text (the story and the player's line are not in it): masked as a whole.
        const scrap = maskForModel(trackerScrap({ placeName: loc?.name || '', displayName: loc?.display_name || '', placeDescription: loc?.description || '', weather, peopleLines: trackerPeopleLines(people), engineLines }));
        const prompt = trackerPrompt({ scrap, player: playerLineBefore(chat, id), story: msg.mes ?? '' });
        const raw = await gen('tracker', { prompt, systemPrompt: trackerSys(), responseLength: 400 }, { at: id, shown: 'marker' }); // "tracking…"
        // Stale: another read started, the swipe changed, or the text it read is no longer the story shown.
        if (trackerGen(msg) !== genNo || swipeOf(msg) !== swipe || ctx().chat?.[id] !== msg || (msg.mes ?? '') !== story || newSwipePending(msg)) return;
        const parsed = readTrackerAnswer(parseJsonAnswer(raw) ?? raw);
        const n = (parsed.place ? 1 : 0) + parsed.people.length + (parsed.wait ? 1 : 0);
        noteCall(id, { kind: 'tracker', status: 'ok', reason: n ? `${n} change${n === 1 ? '' : 's'}` : 'nothing changed' });
        await applyTrackerResult(id, parsed);
        if (trackerGen(msg) === genNo && swipeOf(msg) === swipe) status = hasTrackerCard(msg) ? 'carded' : 'tracked';
    } catch (e) {
        console.warn('[WorldScrawl] tracker', e?.message || e);
        noteCall(id, { kind: 'tracker', status: 'failed', reason: e?.message || String(e) });
        if (trackerGen(msg) === genNo && swipeOf(msg) === swipe) status = 'failed';
    } finally {
        markTracked(msg, genNo, status);
        if (status) { syncSwipeExtra(msg); try { await ctx().saveChat?.(); } catch (e) { console.warn('[WorldScrawl] save', e?.message || e); } }
        renderPatchCards();
    }
}
/** A swipe drops the tracker stamps of the story just left, then reads the swipe now showing. A swipe that is still
 *  being written is read when its reply arrives (onReplyForFlags), not now: mes still holds the old text. */
export async function onStorySwipe(id) {
    if (!isOn()) return;
    const msg = ctx().chat?.[Number(id)];
    if (!msg || msg.is_user || msg.is_system) return;
    dropTrackerMarks(msg);
    bumpTracker(msg);
    invalidateAppearance(msg);
    syncSwipeExtra(msg);
    await runTracker(Number(id));
    await ensureAppearanceRebuilds(Number(id)).catch(e => console.warn('[WorldScrawl] appearance rebuild', e));
}

/** A reply arrived: a pasted [ws_flag: ...] tag is still read. The narrator is not told to write one. */
export async function onReplyForFlags(id) {
    if (!isOn()) return;
    const c = ctx(), msg = c.chat?.[id];
    if (!msg || msg.is_user || msg.is_system) return;
    await refreshLivePlaces();
    let flag = null;
    const emitted = [];
    const norm = normalizeWsTags(msg.mes ?? '');
    if (norm !== (msg.mes ?? '')) { msg.mes = norm; if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes; }
    if (pendingFlag) { flag = pendingFlag; pendingFlag = null; emitted.push(`ws_flag ${flag.kind ?? flag.hint ?? ''} (tool)`.trim()); }
    if (pendingUserFlag) {
        const u = pendingUserFlag; pendingUserFlag = null;
        const um = c.chat?.[u.start];
        if (u.chat === chatKey() && um?.extra?.[FLAG_KEY]?.status === 'user' && replyAfter(c.chat, u.start) === id) { delete um.extra[FLAG_KEY]; flag ??= { note: u.note, hint: u.hint, start: u.start, source: 'button' }; renderPatchCards(); }
    }
    const lf = takeLoreFlags(msg.mes ?? ''), lorePlaces = [...pendingLoreFlags.splice(0), ...lf.places];
    if (lf.text !== (msg.mes ?? '')) {
        msg.mes = lf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (lorePlaces.length) {
        try {
            const loc = await currentLocation();
            msg.extra = msg.extra ?? {};
            msg.extra[LORE_KEY] = (msg.extra[LORE_KEY] ?? []).filter(r => (r?.swipe ?? 0) !== swipeOf(msg));
            for (const pl of new Set(lorePlaces)) requestLore(msg, loc, pl, 'flag');
            await c.saveChat?.();
        } catch (e) { console.warn('[WorldScrawl] lore flag', e.message); }
    }
    const ff = takeFoundFlags(msg.mes ?? ''), foundNames = [...pendingFoundFlags.splice(0), ...ff.names];
    if (ff.text !== (msg.mes ?? '')) {
        msg.mes = ff.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (foundNames.length) await applyFound(msg, foundNames, 'flag');
    const kf = takeNameFlags(msg.mes ?? ''), learned = [...pendingNameFlags.splice(0), ...kf.names];
    if (kf.text !== (msg.mes ?? '')) {
        msg.mes = kf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (learned.length) {
        msg.extra = msg.extra ?? {};
        msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(s => !(s?.type === 'npc_name' && s.source === 'flag' && (s.swipe ?? 0) === swipeOf(msg)));
        for (const nm of new Set(learned)) await learnName(msg, { target: nm, heard: nm, source: 'flag' });
        await c.saveChat?.();
    }
    const nf = takeNpcFlags(msg.mes ?? ''), npcNames = [...pendingNpcFlags.splice(0), ...nf.names];
    if (nf.text !== (msg.mes ?? '')) {
        msg.mes = nf.text.trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (npcNames.length) {
        msg.extra = msg.extra ?? {};
        msg.extra[NPC_FLAG_KEY] = [...(msg.extra[NPC_FLAG_KEY] ?? []).filter(f => (f?.swipe ?? 0) !== swipeOf(msg)), { swipe: swipeOf(msg), names: [...new Set(npcNames)] }];
        await c.saveChat?.();
    }
    const m = FLAG_TAG.exec(msg.mes ?? '');
    if (m) {
        msg.mes = msg.mes.replace(FLAG_TAG, '').trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
        const [hint, ...rest] = m[1].split('|');
        const kind = hint.trim().toLowerCase();
        emitted.push(`ws_flag ${kind}`);
        if ((kind === 'wait' || kind === 'sleep') && !pendingWait) {
            const tg = parseWaitTag(rest.join('|')); const w = await planWait(tg.args, kind === 'sleep' || tg.sleep, tg.reason);
            if (!w.error) pendingWait = w; else { console.warn('[WorldScrawl] wait tag:', w.error); noteCall(id, { kind: `ws_flag ${kind}`, status: 'failed', reason: w.error }); }
        } else if (kind === 'discover') flag ??= { kind: 'discover', hint: '', note: rest.join('|').trim(), source: 'tag' };
        else flag ??= { hint: rest.length ? hint.trim() : '', note: (rest.length ? rest.join('|') : hint).trim(), source: 'tag' };
        await c.saveChat?.();
    }
    const wt = WAIT_TAG.exec(msg.mes ?? '');
    if (wt) {
        emitted.push('wait tag');
        msg.mes = msg.mes.replace(WAIT_TAG, '').trimEnd();
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
        if (!pendingWait) { const tg = parseWaitTag(wt[1]); const w = await planWait(tg.args, tg.sleep, tg.reason); if (!w.error) pendingWait = w; else { console.warn('[WorldScrawl] wait tag:', w.error); noteCall(id, { kind: 'wait tag', status: 'failed', reason: w.error }); } }
        await c.saveChat?.();
    }
    if (pendingWait) { const w = pendingWait; pendingWait = null; await applyProposedWait(id, w); }
    if (flag && flag.kind !== 'wait' && digFailedBefore(c.chat, id)) { console.log('[WorldScrawl] map flag ignored: breaking through failed on this turn, so nothing new opened'); noteCall(id, { kind: `ws_flag ${flag.kind ?? ''}`.trim(), status: 'skipped', reason: 'breaking through failed on this turn' }); flag = null; }
    if (flag) await flagMessage(id, flag);
    const taken = takeNpcTags(msg.mes ?? '');
    const fromTool = pendingNpc.splice(0);
    const stamped = [...fromTool, ...taken.stamps];
    for (const s of fromTool) emitted.push(`${s.type} (tool)`);
    for (const s of taken.stamps) emitted.push(`${s.type} tag`);
    noteCall(id, narratorNote(emitted));
    if (taken.text !== (msg.mes ?? '')) {
        msg.mes = taken.text;
        if (Array.isArray(msg.swipes) && msg.swipes[swipeOf(msg)] !== undefined) msg.swipes[swipeOf(msg)] = msg.mes;
        try { c.updateMessageBlock?.(id, msg); } catch {}
    }
    if (stamped.length) await applyPersonStamps(id, stamped);
    const bad = unreadTags(msg.mes ?? '');
    msg.extra = msg.extra ?? {};
    const keepBad = (msg.extra[BADTAG_KEY] ?? []).filter(b => (b?.swipe ?? 0) !== swipeOf(msg));
    if (bad.length || keepBad.length !== (msg.extra[BADTAG_KEY] ?? []).length) {
        msg.extra[BADTAG_KEY] = bad.length ? [...keepBad, { swipe: swipeOf(msg), tags: bad }] : keepBad;
        for (const t of bad) { console.warn('[WorldScrawl] unreadable tag:', t); noteCall(id, { kind: 'warning', status: 'failed', reason: `unreadable tag: ${t}` }); }
        await c.saveChat?.();
    }
    markUnreadTags();
    await runTracker(id);
    maybeSuggest(id);
        if (msg.extra?.[REMEMBER_KEY] || (msg.extra?.[NPC_KEY] ?? []).length || (msg.extra?.[FOUND_KEY] ?? []).length || (msg.extra?.[NPC_WARN_KEY] ?? []).length) { await c.saveChat?.(); renderPatchCards(); }
}
const BADTAG_KEY = 'worldscrawl_badtags';
export const BADTAG_TITLE = "WorldScrawl couldn't read this tag";
/** Unread [ws_...] tags stay in the message, wrapped in a visible warning marker. */
export function markUnreadTags(root = globalThis.document) {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll('.mes_text')) {
        const walker = el.ownerDocument.createTreeWalker(el, 4);
        const hits = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\[\s*ws[_ ]/i.test(n.nodeValue) && !n.parentElement?.closest('.worldscrawl_badtag')) hits.push(n);
        for (const n of hits) {
            const frag = el.ownerDocument.createDocumentFragment();
            let last = 0; const txt = n.nodeValue;
            for (const m of txt.matchAll(/\[\s*ws[_ ][^\]]{0,300}\]/gi)) {
                frag.append(txt.slice(last, m.index));
                const sp = el.ownerDocument.createElement('span');
                sp.className = 'worldscrawl_badtag'; sp.title = BADTAG_TITLE; sp.style.cssText = 'color:#b8860b;background:rgba(255,200,0,.15);border:1px dashed #b8860b;border-radius:3px;padding:0 2px;cursor:help'; sp.textContent = `⚠ ${m[0]}`;
                frag.append(sp); last = m.index + m[0].length;
            }
            if (!last) continue;
            frag.append(txt.slice(last)); n.replaceWith(frag);
        }
    }
}
/** Did the player's turn just before reply `id` fail to break through? Then the reply must not add a room or passage. */
export function digFailedBefore(chat, id) {
    for (let i = id - 1; i >= 0; i--) { const m = chat[i]; if (m?.is_user) return !!m.extra?.worldscrawl_dig_failed; if (m && !m.is_system) return false; }
    return false;
}

export { analyzeDiscovery, discardFlag, keepFlag, registerTools, syncSwipeExtra, undoFlag };
