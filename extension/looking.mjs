// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { LOOK_RE, lookOnly } from './words.mjs';
import { render as P } from './shared.mjs';
import { LEAVING_RE, LOOK_AROUND_RE, WAY_OUT_PREFIX, checkExitChoice } from './brackets.mjs';
import { askValid, baseReply, gen, narrativeDig, nearbyRooms } from './dig.mjs';
import { barrierOf, barrierWord, changesOf, currentLocation, doorCandidates, doorChange, doorOverrides, ensurePrompts, isStuck, openChanges, sightOf, soundOf, stuckWhy, viewOf } from './doors.mjs';
import { fetchLocationCached } from './footer.mjs';
import { CHANGE_KEY, ctx } from './index.js';
import { BREAK_RE, ELSEWHERE, OPEN, STAY, UNCLEAR, cleanAnswer, destLabel, discoveredTargets, displayName, engineMove, engineTravel, exitLabel, exitLabels, hereAreas, keyFor, keyWords, matchCandidates, matchKey, namedInText, nearestWaysOut, normKey, optionLines, parseIntentAnswer, parseYesNo, partyText, pickKey, previousAddress, revealsDestination, sameName, stamp, travelCandidates, trimAnswer, words } from './movement.mjs';

// ---- Looking and doors (the party never moves).
export const LOOK = 'look', OPEN_DOOR = 'open a door', CLOSE_DOOR = 'close a door', NEW_DOOR = 'try another door';
export const DOOR_OPEN_RE = /\b(?:open|opens|opened|opening|unlatch\w*|unbar\w*)\b/i;
export const DOOR_CLOSE_RE = /\b(?:close|closes|closed|closing|shut|shuts|shutting|slam|slams|slammed|slamming)\b/i;
export const NO_EXIT = 'out a window or opening with no exit';
const exitTargetLabel = e => `the ${e.direction} exit${revealsDestination(e) ? ` (to ${destLabel(e)})` : ''}`;
export const AROUND = 'around here in general, nothing specific';
export const WINDOW_WORD_RE = /\b(?:windows?|shutters?|outside|outdoors|openings?|balcon(?:y|ies)|portholes?|skylights?)\b/i;
/** Offer the window option only when the player mentions one, or the room already has a view. */
export const offerWindow = (loc, text) => WINDOW_WORD_RE.test(String(text ?? '')) || (loc.views ?? []).length > 0;
/** Options: `around`, then one key per exit, then (maybe) `window`, last. */
export function lookOptions(exits, withWindow = true) {
    const taken = new Set(['around', 'window']);
    return [{ key: 'around', label: AROUND }, ...exits.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), exit: e })), ...(withWindow ? [{ key: 'window', label: NO_EXIT }] : [])];
}
export function lookTargetPrompt(loc, said, exits, withWindow = true) {
    return P('look.target', { party: partyText(), place: displayName(loc), said, options: optionLines(lookOptions(exits, withWindow)) });
}
export const DOOR_LOOK = ['listen', 'peek', 'open', 'look'];
export const closedDoorPrompt = (said, e) => P('look.closed_door', { said, direction: e.direction });
/** One option per nearby room, keyed by its name. */
/** Short keys from the place name; the area is added only when two nearby places share a name. */
export const roomOptions = (rooms, taken = new Set()) => {
    const n = {}; for (const r of rooms) { const k = normKey(r.name ?? r.display_name); n[k] = (n[k] ?? 0) + 1; }
    return rooms.map(r => ({ key: keyFor(n[normKey(r.name ?? r.display_name)] > 1 ? r.display_name : (r.name ?? r.display_name), taken), label: `${r.display_name}: ${r.summary}`, room: r }));
};
export function viewPickPrompt(loc, said, rooms) {
    return P('look.view', { party: partyText(), place: displayName(loc), description: loc.description ?? '', said, places: optionLines(roomOptions(rooms)) });
}
/** The 'look' intent: pick an exit (or a window), then see / hear / nothing. Stamps door and view-link changes on the message. */
async function narrativeLook(msg, loc, forced = null, forcedAct = null) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exits = loc.exits.filter(e => !e.hidden || revealsDestination(e)); // an unrevealed hidden exit is never named
    const stampChange = c => { msg.extra[CHANGE_KEY] = [...changesOf(msg), c]; };
    let look;
    if (!forced && LOOK_AROUND_RE.test(String(msg.mes ?? ''))) look = { kind: 'around' }; // 'I look around': no question, no view link
    const win = !look && offerWindow(loc, msg.mes);
    const pick = look ? null : forced ?? await askValid('look target', lookTargetPrompt(loc, said, exits, win), pickKey(lookOptions(exits, win)));
    if (look) { /* around */ }
    else if (pick == null) look = { kind: 'nothing' };
    else if (pick.key === 'around') look = { kind: 'around' };
    else if (pick.exit) {
        const e = pick.exit;
        const open = doorOverrides();
        let v = viewOf(e, open), opened = false, through = false, stuck = false;
        if (v === 'closed' && sightOf(e, open) !== 'none') { v = 'open'; through = true; } // a closed gate/grate: seen through as it is
        else if (v === 'closed') {
            const act = forcedAct ?? await askValid('closed door', closedDoorPrompt(said, e), a => matchKey(a, DOOR_LOOK)) ?? 'look'; // unreadable: just looking (never opens a door by accident)
            if (act === 'listen') v = 'listen';
            else if (act === 'open' && isStuck(e, open)) { v = 'shut'; stuck = true; }
            else if (act === 'open') { openChanges(loc, e).forEach(stampChange); opened = true; v = 'open'; }
            else if (act === 'peek' && barrierOf(e).openable === false) v = 'shut'; // rubble: no crack to peek through
            else if (act === 'peek') { msg.extra.worldscrawl_peek = { type: 'peek', door: e.direction, from: loc.address }; v = 'peek'; } // no effect on door state (for a later stealth mechanic)
            else v = 'shut';
        }
        const t = (v === 'open' || v === 'peek') && revealsDestination(e) && e.to ? await fetchLocationCached(e.to) : null;
        const lvl = sightOf(e, opened ? new Map([[e.door, { type: 'open_door' }]]) : open);
        look = v === 'listen' ? { kind: 'listen', via: e.direction, sound: soundOf(e, open), word: barrierWord(e) }
            : v === 'shut' && !stuck && e.description && !revealsDestination(e) ? { kind: 'threshold', via: e.direction, description: e.description, shut: true, unknown: !revealsDestination(e) }
            : v === 'shut' ? { kind: 'closed', via: e.direction, word: barrierWord(e), ...(stuck ? { stuck: stuckWhy(e) } : {}) }
            : t ? { kind: 'see', via: e.direction, to: t.address, name: displayName(t), description: t.description, opened, ...(v === 'peek' ? { peek: true } : { sight: lvl }), ...(through ? { through_closed: true } : {}) }
            : e.description && v !== 'shut' ? { kind: 'threshold', via: e.direction, description: e.description, opened, ...(through ? { through_closed: true } : {}), ...(v === 'peek' ? { peek: true } : {}), unknown: !revealsDestination(e), ...(revealsDestination(e) && (e.to_label ?? e.to_name) ? { name: e.to_label ?? e.to_name } : {}) }
            : { kind: 'nothing', via: e.direction, opened };
    } else {
        let view = (loc.views ?? [])[0]; // hand-written views first, then an earlier view link: the same answer every time
        if (!view) {
            const rooms = await nearbyRooms(loc);
            const k = rooms.length ? await askValid('view', viewPickPrompt(loc, said, rooms), pickKey(roomOptions(rooms))) : null;
            if (k != null) { view = k.room; stampChange({ type: 'view_link', from: loc.address, to: view.address }); }
        }
        const t = view ? await fetchLocationCached(view.address) : null;
        look = t ? { kind: 'see', window: true, to: t.address, name: displayName(t), description: t.description } : { kind: 'nothing', window: true };
    }
    if (!changesOf(msg).length) delete msg.extra[CHANGE_KEY];
    msg.extra.worldscrawl_look = look;
    console.log(`[WorldScrawl] look: ${JSON.stringify(look).slice(0, 160)}`);
    return { kind: 'look', loc };
}
export const doorOptions = list => { const taken = new Set(); return list.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), exit: e })); };
export const doorPickPrompt = (loc, said, list, type) => P('door.pick', { party: partyText(), place: displayName(loc), said, verb: type === 'open_door' ? 'open' : 'close', options: optionLines(doorOptions(list)) });
/** The open/close door intents: which door (asked only if several), stamped on the message. */
async function narrativeDoor(msg, loc, list, type) {
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    let e = list.length === 1 ? list[0] : null;
    if (!e) {
        e = (await askValid('door', doorPickPrompt(loc, said, list, type), pickKey(doorOptions(list))))?.exit ?? null;
    }
    if (!e) return { kind: STAY, loc };
    if (type === 'open_door' && isStuck(e)) { msg.extra.worldscrawl_door = { type: 'stuck', direction: e.direction, why: stuckWhy(e) }; return { kind: 'door', loc }; }
    msg.extra[CHANGE_KEY] = [...changesOf(msg), ...(type === 'open_door' ? openChanges(loc, e) : [doorChange(type, loc, e)])];
    msg.extra.worldscrawl_door = { type, direction: e.direction };
    return { kind: 'door', loc };
}
export const DIG_FAILED_NOTICE = 'Nothing gave way: no new opening was made.';

export const travelSys = () => P('travel.system');
export const travelYesNoPrompt = (loc, said) => P('travel.question', { party: partyText(), place: loc.name, said });
export const intentSys = () => P('intent.system', { reply: baseReply('one') });

/**
 * Ask the model one multiple-choice question about the player's message.
 * Returns {kind:'move'|'stay'|'elsewhere', loc}. An unreadable answer gets a yes/no follow-up
 * ("trying to travel?"): a clear yes is 'elsewhere', anything else is 'stay'.
 */
export function intentPrompt({ loc, exitLines, said, moveDirs, movePlaces, canOpen, canLook, canOpenDoor, canCloseDoor, canNewDoor, onlyLook, options }) {
    const opt = (id, option) => P(`intent.option.${id}`, { option }) + '\n';
    const lines = moveDirs.map(d => P('intent.option.exit', { direction: d }) + '\n').join('')
        + movePlaces.map(p => P('intent.option.place', { label: p.label }) + '\n').join('')
        + (canOpen ? opt('new_opening', OPEN) : '') + (canLook ? opt('look', LOOK) : '') + (canOpenDoor ? opt('open_door', OPEN_DOOR) : '')
        + (canCloseDoor ? opt('close_door', CLOSE_DOOR) : '') + (canNewDoor ? opt('new_door', NEW_DOOR) : '') + opt('stay', STAY)
        + (onlyLook ? '\n' : opt('elsewhere', ELSEWHERE) + opt('unclear', UNCLEAR) + '\n');
    return P('intent.question', { party: partyText(), place: displayName(loc), exits: exitLines.join('\n') || '- (none)', said, option_lines: lines, options: options.join(', ') });
}
async function parseIntent(msg) {
    await ensurePrompts();
    const c = ctx();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    const loc = await currentLocation();
    const dirs = loc.exits.map(e => e.direction);
    const places = await discoveredTargets(loc);
    const prev = previousAddress(loc.address);
    const canOpen = BREAK_RE.test(msg.mes ?? ''); // the 'new opening' choice is only offered when the player uses a breaking-through word
    const canLook = LOOK_RE.test(msg.mes ?? '');
    const doors = doorCandidates(loc);
    doors.toOpen = [...doors.toOpen, ...doors.stuck]; // trying a locked door is still the 'open' intent; it just doesn't give
    const canOpenDoor = DOOR_OPEN_RE.test(msg.mes ?? '') && doors.toOpen.length > 0, canCloseDoor = DOOR_CLOSE_RE.test(msg.mes ?? '') && doors.toClose.length > 0;
    const canNewDoor = DOOR_OPEN_RE.test(msg.mes ?? '') && loc.expandable !== false; // a door not on the map yet: maybe a discovery
    const extras = [...(canOpen ? [OPEN] : []), ...(canLook ? [LOOK] : []), ...(canOpenDoor ? [OPEN_DOOR] : []), ...(canCloseDoor ? [CLOSE_DOOR] : []), ...(canNewDoor ? [NEW_DOOR] : [])];
    // Only looking ("I look out the door"): no move options, so a word like "out" can't pick the "out" exit.
    const onlyLook = canLook && lookOnly(msg.mes);
    const moveDirs = onlyLook ? [] : dirs, movePlaces = onlyLook ? [] : places;
    const options = [...moveDirs, ...movePlaces.map(p => p.label), ...extras, STAY, ...(onlyLook ? [] : [ELSEWHERE, UNCLEAR])];
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const exitLines = exitLabels(loc.exits, n => n).map((lbl, i) => {
        const e = loc.exits[i];
        const nm = lbl.length > e.direction.length ? lbl.slice(e.direction.length) : destLabel(e); // same label as the footer: room, or building (+ room / region)
        return `- ${e.direction}${revealsDestination(e) ? ` (to ${nm}${e.to === prev ? ', where you came from' : ''})` : ''}`;
    });
    const prompt = intentPrompt({ loc, exitLines, said, moveDirs, movePlaces, canOpen, canLook, canOpenDoor, canCloseDoor, canNewDoor, onlyLook, options });
    const answer = await gen('intent', { prompt, systemPrompt: intentSys(), responseLength: 48 });
    const cands = await travelCandidates(loc);
    // Without the word check passing, "new opening" is not an option: such an answer falls through to the normal handling.
    let choice = parseIntentAnswer(answer, [...dirs, ...places.map(p => p.label), ...extras]);
    if (choice === OPEN) return await narrativeDig(msg, loc);
    if (choice === LOOK) return await narrativeLook(msg, loc);
    if (choice === NEW_DOOR) { msg.extra.worldscrawl_new_door = true; return { kind: STAY, loc }; }
    if (choice === OPEN_DOOR || choice === CLOSE_DOOR) return await narrativeDoor(msg, loc, choice === OPEN_DOOR ? doors.toOpen : doors.toClose, choice === OPEN_DOOR ? 'open_door' : 'close_door');
    if (onlyLook) { console.log(`[WorldScrawl] look-only message, answer ${JSON.stringify(String(answer).slice(0, 40))} -> stay`); return { kind: 'stay', loc }; }
    const ans = trimAnswer(cleanAnswer(answer));
    const insideAns = !dirs.includes(choice) && hereAreas(loc).find(a => sameName(a.name, choice ?? ans));
    if (insideAns) return { kind: 'already', loc, name: insideAns.name };
    if (!choice) { // a bare name that matches known places (e.g. "Upstairs Rooms")
        const m = matchCandidates(trimAnswer(cleanAnswer(answer)), cands);
        if (m.length > 1) return { kind: 'which', loc, candidates: m };
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
    }
    if (!choice) {
        const yn = await gen('intent: travel yes/no', { prompt: travelYesNoPrompt(loc, said), systemPrompt: travelSys(), responseLength: 48 });
        choice = parseYesNo(yn) === 'yes' ? ELSEWHERE : STAY;
        console.log(`[WorldScrawl] intent fallback: ${JSON.stringify(String(yn).slice(0, 80))} -> ${choice}`);
    }
    console.log(`[WorldScrawl] intent: ${JSON.stringify(String(answer).slice(0, 80))} -> ${choice}`);
    if (dirs.includes(choice)) choice = checkExitChoice(msg.mes, loc.exits.find(e => e.direction === choice), cands) ?? choice;
    if (choice === STAY) return { kind: STAY, loc };
    if (choice === ELSEWHERE || choice === UNCLEAR) {
        const inside = namedInText(msg.mes, hereAreas(loc))[0];
        if (inside) {
            if (LEAVING_RE.test(msg.mes ?? '')) {
                // "I leave the Drowned Rat": the exits from this room that lead out of the named building/region
                const isRegion = sameName(inside.name, loc.region?.name ?? '') && !sameName(inside.name, loc.subregion?.name ?? '');
                const regionOf = a => a.split(':')[0];
                const outs = loc.exits.filter(e => revealsDestination(e) && (isRegion ? regionOf(e.to) !== regionOf(loc.address) : e.to_subregion?.id !== loc.subregion?.id));
                if (outs.length === 1) choice = outs[0].direction;
                else if (outs.length > 1) return { kind: 'which', loc, prefix: WAY_OUT_PREFIX, candidates: outs.map(e => ({ label: exitLabel(e), name: e.to_name, direction: e.direction, address: e.to })) };
                else { // no way out from this room: nearest way out through visited rooms (normal route rules)
                    const best = await nearestWaysOut(loc, isRegion);
                    if (best.length === 1) {
                        const res = await engineTravel(best[0].address);
                        if (!res.ok) return { kind: ELSEWHERE, loc };
                        stamp(msg, res.to, res.move);
                        return { kind: 'move', loc: res.to };
                    }
                    if (best.length > 1) return { kind: 'which', loc, prefix: WAY_OUT_PREFIX, candidates: best };
                    return { kind: ELSEWHERE, loc };
                }
            } else if (!namedInText(msg.mes, cands).length) return { kind: 'already', loc, name: inside.name };
        }
    }
    if (choice === ELSEWHERE) { // safety net: the player named a known place the model didn't pick
        const named = namedInText(msg.mes, cands);
        if (named.length > 1) return { kind: 'which', loc, candidates: named };
        if (named.length === 1) choice = named[0].direction ?? named[0].label;
        else return { kind: ELSEWHERE, loc };
    }
    if (choice === UNCLEAR) {
        const m = namedInText(msg.mes, cands);
        if (m.length === 1) choice = m[0].direction ?? m[0].label;
        else return { kind: 'which', loc, candidates: m.length ? m : cands };
    }
    let place = places.find(p => p.label === choice) ?? (dirs.includes(choice) ? null : cands.find(x => x.label === choice && !x.direction));
    if (place && !place.area) {
        // The player named a building ("go to the Drowned Rat") but the model picked one of its rooms (often the
        // entrance). Unless the room's own name was said, go to the building: its nearest known room.
        const said = new Set(words(msg.mes));
        const area = !keyWords(place.name).some(w => said.has(w))
            && cands.find(x => x.area && x.prefix && place.address.startsWith(x.prefix) && namedInText(msg.mes, [x]).length);
        if (area) { console.log(`[WorldScrawl] building named, model picked a room: ${place.label} -> ${area.label}`); place = area; }
    }
    const nearArea = !dirs.includes(choice) && cands.find(x => x.label === choice && x.area);
    if (nearArea && hereAreas(loc).some(a => sameName(a.name, nearArea.name))) return { kind: 'already', loc, name: nearArea.name };
    const res = place ? await engineTravel(place.address, place.prefix ?? null) : await engineMove(choice);
    if (!res.ok) return { kind: ELSEWHERE, loc, noRoute: place?.label ?? null };
    stamp(msg, res.to, res.move);
    return { kind: 'move', loc: res.to };
}

export { exitTargetLabel, narrativeDoor, narrativeLook, parseIntent };
