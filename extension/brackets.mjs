// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { durationWords } from './words.mjs';
import { render as P } from './shared.mjs';
import { LORE_KEY } from './npc.mjs';
import { askValid, narrativeDig } from './dig.mjs';
import { barHere, barrierOf, changesOf, currentLocation, doorCandidates, doorChange, ensurePrompts, isBarredNow, isOpenNow, sightOf, soundOf } from './doors.mjs';
import { exitsText } from './footer.mjs';
import { CHANGE_KEY, ctx, toolsOn } from './index.js';
import { doorOptions, exitTargetLabel, lookOptions, narrativeDoor, narrativeLook, whichDoorText } from './looking.mjs';
import { ELSEWHERE, STAY, alreadyText, displayName, engineMove, engineTravel, keyFor, namedInText, optionLines, partyText, pickKey, sameName, sameWord, stamp, stuckAttempt, travelCandidates, words } from './movement.mjs';
import { revealsDestination } from './shared.mjs';
import { castPack, learnNameOn, loreChain, offerRemember, renderTokens, requestLore, runFind } from './scene.mjs';
import { planWait, stampWait } from './waits.mjs';

// ---- Bracket commands: "I [move] north", "I [look] out the window". One verb table for bracket verbs and slash
// commands: a recognised verb skips the intent question; its target is matched exactly from the words after it, with
// one small target-only question if that fails. Unknown bracket words ([OOC: ...], [sic]) are left alone.
export const VERBS = [
    { id: 'move', words: ['move', 'go', 'walk'], slash: '/ws-go <exit or place>', help: 'go through an exit or to a known place, e.g. [move] north' },
    { id: 'travel', words: ['travel'], slash: '/ws-go <place>', help: 'travel to a place you know, e.g. [travel] Village Square' },
    { id: 'look', words: ['look'], slash: null, help: 'look around, at an exit, or out a window, e.g. [look] out the window' },
    { id: 'open', words: ['open'], slash: '/ws-open <exit>', help: 'open a door here, e.g. [open] trapdoor' },
    { id: 'close', words: ['close', 'shut'], slash: '/ws-close <exit>', help: 'close a door here, e.g. [close] door' },
    { id: 'bar', words: ['bar'], slash: '/ws-bar [exit]', help: 'bar a door from the side its bar is on, e.g. [bar] the cellar door' },
    { id: 'unbar', words: ['unbar'], slash: '/ws-unbar [exit]', help: 'lift the bar on a door, e.g. [unbar] door' },
    { id: 'dig', words: ['dig', 'break', 'break through'], slash: '/ws-dig <exit> <place>', help: 'break a new opening, e.g. I [break through] the wall' },
    { id: 'wait', words: ['wait'], slash: '/ws-wait <time>', help: 'let time pass here, e.g. [wait] 2h or [wait] until morning' },
    { id: 'sleep', words: ['sleep'], slash: '/ws-sleep [time]', help: 'sleep here (8h unless you say), e.g. [sleep] until morning' },
    { id: 'lore', words: ['lore'], slash: null, help: 'bring up what locals know about this place (its lore) for the rest of the scene, e.g. [lore] or [lore] The Drowned Rat' },
    { id: 'help', words: ['help'], slash: '/ws-help', help: 'list these commands' },
    { id: 'remember', words: ['remember'], slash: '/ws-npc <name>', help: 'remember a person from the story, e.g. I [remember] Maren' },
    { id: 'find', words: ['find'], slash: '/ws-find <name>', help: 'look for someone who might be around: if this room is one of the places they could be right now, they come here until their current stretch ends, e.g. [find] Hesk' },
    { id: 'name', words: ['name'], slash: '/ws-name <name>', help: 'you know this person\'s name from now on, e.g. [name] Hesk' },
];
const VERB_OF = new Map(VERBS.flatMap(v => v.words.map(w => [w, v])));
const TARGET_FILLER = new Set(['to', 'the', 'a', 'an', 'at', 'through', 'into', 'in', 'toward', 'towards', 'out', 'of', 'my', 'way']);
/** The first bracket whose word is a known verb: {verb, target, raw}, or null. "out" stays when it is all there is ("[move] out").
 *  A colon or dot between digits is part of the target ("[wait] until 17:15"), not the end of the sentence.
 *  A [remember] anywhere in the message wins over any other verb in it, then a [help]: the whole message is that command.
 *  Otherwise two or more verbs are marked `multi` (bracketIntent fails the message: one verb per message for now). */
export function parseBracket(text) {
    let first = null, help = null, count = 0;
    for (const m of String(text ?? '').matchAll(/\[([^\[\]]{1,40})\]((?:[^\[\n.!?,;:]|(?<=\d)[:.](?=\d))*)/g)) {
        const v = VERB_OF.get(m[1].trim().toLowerCase().replace(/\s+/g, ' '));
        if (!v) continue;
        const words = m[2].trim().split(/\s+/).filter(Boolean);
        let i = 0;
        while (i < words.length - 1 && TARGET_FILLER.has(words[i].toLowerCase())) i++;
        if (words.length === 1 && TARGET_FILLER.has(words[0].toLowerCase()) && !['out', 'in'].includes(words[0].toLowerCase())) i = 1;
        const b = { verb: v.id, word: m[1].trim(), target: words.slice(i).join(' '), raw: m[0] };
        if (b.verb === 'remember') return b;
        if (b.verb === 'help') help ??= b;
        count++;
        first ??= b;
    }
    if (help) return help;
    return first && count > 1 ? { ...first, multi: count } : first;
}
/** The notice for a message with two or more action verbs (an outright failure: no reply, the message hidden). */
export const ONE_VERB = 'One verb per message for now.';
/** Bracketed verbs read as plain words for the narrator ("I [move] north" -> "I move north"). */
export const unbracket = text => String(text ?? '').replace(/\[([^\[\]]{1,40})\]/g, (all, w) => (VERB_OF.has(w.trim().toLowerCase().replace(/\s+/g, ' ')) ? w.trim() : all));
/** Slash commands with no bracket verb (listed by /ws-help after the verbs). */
export const SLASH_ONLY = [
    ['/ws-change [what changed]', 'the map changed in the latest message (fire, collapse...): work out the change'],
    ['/ws-exits', 'show the exits from here'], ['/ws-known', 'list the places this chat knows'],
    ['/ws-reveal all|region|subregion|<id>|off', 'debug: Reveal map (places count as visited, so you can travel there)'],
    ['/ws-reveal names|names off', 'debug: Reveal names (the model sees every real name)'],
    ['/ws-removeexit <exit>', 'remove an exit from this room'], ['/ws-map', 'open the map window'],
    ['/ws-know <name> | unmet|met|named', 'set how well you and a saved person know each other (the only way back)'],
    ['/ws-save-world <name>', "save this chat's world as a new world"], ['/ws-on, /ws-off', 'turn WorldScrawl on or off in this chat'],
];
export const helpText = () => `WorldScrawl commands. Write a verb in brackets in your message (one per message; [remember] and [help] win over the rest), or use the slash command:\n${VERBS.map(v => `- [${v.words[0]}]${v.slash ? ` (${v.slash})` : ''}: ${v.help}`).join('\n')}\nSlash commands only:\n${SLASH_ONLY.map(([c, h]) => `- ${c}: ${h}`).join('\n')}`;
export const bracketTargetPrompt = (loc, b, opts) => P('intent.bracket_target', { party: partyText(), place: displayName(loc), verb: b.word, target: b.target, options: optionLines(opts) });
/** Exact match first (an exit name, then a place), else one small target-only question; null when nothing fits. */
async function bracketTarget(loc, b, opts) {
    if (!b.target || !opts.length) return null;
    const exact = opts.filter(o => sameName(o.match ?? o.key, b.target) || sameName(o.key, b.target));
    if (exact.length === 1) return exact[0];
    const pick = pickKey(opts);
    return (await askValid('bracket target', bracketTargetPrompt(loc, b, opts), a => (/^none\b/i.test(String(a).trim()) ? false : pick(a)))) || null; // 'none': no retries
}
/** An outright failure: always a command (the message is stamped with the error and hidden, no reply). */
const failed = (loc, note) => ({ kind: 'bracket_failed', loc, note, command: true });
/** Handle one bracket verb on the player's message. Returns a parseIntent-style result. */
export async function bracketIntent(msg, b) {
    await ensurePrompts();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    msg.extra.worldscrawl_bracket = { verb: b.verb, target: b.target };
    const loc = await currentLocation();
    const exitsSeen = loc.exits.filter(e => !e.hidden || revealsDestination(e));
    if (b.verb === 'help') return { kind: 'help', loc, command: true }; // a pure system command: the verb list, no reply
    if (b.verb === 'remember') { const r = await offerRemember(msg, b.target); return r.ok ? { kind: 'remember', loc, command: true } : failed(loc, r.reason); }
    if (b.multi) return failed(loc, ONE_VERB); // two or more action verbs: nothing is done
    if (b.verb === 'name') { const r = await learnNameOn(msg, b.target); if (!r.ok) return failed(loc, r.reason); return { kind: 'name', loc }; }
    if (b.verb === 'find') {
        // Empty or unknown: an outright failure. Right here: a command (the "right here" card, no reply). Found, or a known
        // person who is not around: narrated (the not-found line goes after the player's message).
        const f = await runFind(msg, b.target);
        if (f.outcome === 'empty' || f.outcome === 'unknown') return failed(loc, f.reason);
        if (f.outcome === 'here') return { kind: 'find', loc, command: true };
        return { kind: 'found', loc };
    }
    if (b.verb === 'lore') {
        const hits = requestLore(msg, loc, b.target ?? '', 'bracket');
        if (!hits.length) {
            msg.extra[LORE_KEY] = (msg.extra[LORE_KEY] ?? []).slice(0, -1);
            const known = [...loreChain(loc).map(c => c.name), ...(castPack()?.elsewhere ?? []).filter(s => s.lore && !s.shadowed).map(s => s.name)]; // name-ok: place names
            return failed(loc, known.length ? `[${b.word}]${b.target ? ` ${b.target}` : ''}: lore on file: ${[...new Set(known)].join(', ')}.` : `[${b.word}]: no lore on file here.`);
        }
        return { kind: 'lore', loc };
    }
    if (b.verb === 'move' || b.verb === 'travel') {
        if (!b.target) return failed(loc, `[${b.word}] needs where to: an exit or a place you know.`);
        const taken = new Set(), cands = await travelCandidates(loc);
        const opts = [...(b.verb === 'move' ? exitsSeen.map(e => ({ key: keyFor(e.direction, taken), label: exitTargetLabel(e), match: e.direction, exit: e })) : []),
            ...cands.filter(x => !x.direction).map(x => ({ key: keyFor(x.name ?? x.label, taken), label: x.label, match: x.name ?? x.label, place: x }))];
        const hit = await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, `[${b.word}] ${b.target}: there is no exit or known place called "${b.target}" here.`);
        const res = hit.exit ? await engineMove(hit.exit.direction) : await engineTravel(hit.place.address, hit.place.prefix ?? null);
        if (!res.ok && res.stuck) { stuckAttempt(msg, res.stuck); return { kind: 'door', loc }; } // a stuck door: the attempt is narrated
        if (!res.ok) return failed(loc, `[${b.word}] ${b.target}: ${res.error ?? 'there is no way there from here.'}`);
        stamp(msg, res.to, res.move);
        return { kind: 'move', loc: res.to };
    }
    if (b.verb === 'look') {
        const t = b.target.toLowerCase();
        if (!t || /^(around|about|here|room)$/.test(t)) return await narrativeLook(msg, loc, { key: 'around' });
        if (/\b(window|opening)\b/.test(t) && !exitsSeen.some(e => sameName(e.direction, t))) return await narrativeLook(msg, loc, { key: 'window' });
        const opts = lookOptions(exitsSeen, false).filter(o => o.exit).map(o => ({ ...o, match: o.exit.direction }));
        const hit = await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, `[${b.word}] ${b.target}: there is no "${b.target}" to look at here.`);
        return await narrativeLook(msg, loc, hit, 'look');
    }
    if (b.verb === 'open' || b.verb === 'close') {
        const d = doorCandidates(loc), list = b.verb === 'open' ? [...d.toOpen, ...d.stuck] : d.toClose;
        const opts = doorOptions(list).map(o => ({ ...o, match: o.exit.direction }));
        const hit = list.length === 1 && !b.target ? opts[0] : await bracketTarget(loc, b, opts);
        if (!hit) return failed(loc, !list.length ? `[${b.word}]: no door to ${b.verb} here.` : !b.target ? whichDoorText(b.verb, list) : `[${b.word}] ${b.target}: doors you can ${b.verb} here: ${list.map(x => x.direction).join(', ')}.`);
        return await narrativeDoor(msg, loc, [hit.exit], b.verb === 'open' ? 'open_door' : 'close_door');
    }
    if (b.verb === 'bar' || b.verb === 'unbar') {
        const bars = exitsSeen.filter(e => e.door && barrierOf(e)?.barred_from), mine = bars.filter(barHere);
        const list = mine.filter(e => (b.verb === 'bar') !== isBarredNow(e));
        const opts = doorOptions(list).map(o => ({ ...o, match: o.exit.direction }));
        const hit = list.length === 1 && !b.target ? opts[0] : await bracketTarget(loc, b, opts);
        if (!hit) {
            const far = b.target && bars.find(e => !barHere(e) && sameName(e.direction, b.target));
            return failed(loc, far ? `[${b.word}] ${b.target}: the bar on that door is on the other side.`
                : list.length ? `[${b.word}] ${b.target}: doors you can ${b.verb} here: ${list.map(x => x.direction).join(', ')}.` : `[${b.word}]: no door to ${b.verb} here${mine.length ? ` (${mine.map(x => x.direction).join(', ')} ${mine.length === 1 ? 'is' : 'are'} already ${b.verb === 'bar' ? 'barred' : 'unbarred'})` : ' with a bar on this side'}.`);
        }
        const e = hit.exit;
        msg.extra[CHANGE_KEY] = [...changesOf(msg), ...(b.verb === 'bar' ? [...(isOpenNow(e) ? [doorChange('close_door', loc, e)] : []), doorChange('bar_door', loc, e)] : [doorChange('unbar_door', loc, e)])];
        msg.extra.worldscrawl_door = { type: `${b.verb}_door`, direction: e.direction };
        return { kind: 'door', loc };
    }
    if (b.verb === 'dig') return await narrativeDig(msg, loc);
    if (b.verb === 'wait' || b.verb === 'sleep') {
        const w = await planWait(b.target, b.verb === 'sleep');
        if (w.error) return failed(loc, `[${b.word}] ${b.target}: ${w.error}.`);
        stampWait(msg, w);
        return { kind: STAY, loc };
    }
    return null;
}

const MENTION_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'into', 'onto', 'in', 'on', 'at', 'by', 'and', 'or', 'with', 'from', 'back', 'behind', 'beside', 'down', 'up', 'out', 'its', 'set', 'leading', 'leads', 'way', 'room', 'rooms']);
/** Does the player's text refer to this exit itself (its word, or a word of its description: "down the stair" -> grate)? */
export function exitMentioned(text, exit) {
    const said = new Set(words(text));
    const own = [...words(exit?.direction), ...words(exit?.description)].filter(w => w.length > 2 && !MENTION_STOP.has(w));
    return words(exit?.direction).some(w => said.has(w)) || own.some(w => [...said].some(t => sameWord(t, w)));
}
/**
 * Second look at an exit the model picked (null = keep it). The model tends to guess an exit for a place it
 * doesn't know ("the secret tunnel" -> the grate). Unless the player referred to the exit itself:
 * an unrevealed hidden/obscured exit is never a guess for a named place (-> elsewhere: the normal notices);
 * a normal exit loses to a single known place the player named that it doesn't lead to.
 */
export function checkExitChoice(text, exit, cands) {
    if (!exit || exitMentioned(text, exit)) return null;
    if (!revealsDestination(exit)) { console.log(`[WorldScrawl] model picked the unrevealed "${exit.direction}" exit, not mentioned by the player -> elsewhere`); return ELSEWHERE; }
    const named = namedInText(text, cands);
    if (named.length !== 1) return null;
    const n = named[0];
    if (n.address === exit.to || n.direction === exit.direction || (n.prefix && String(exit.to).startsWith(n.prefix))) return null;
    console.log(`[WorldScrawl] model picked "${exit.direction}" but the player named ${n.label}`);
    return n.direction ?? n.label;
}

export const WHICH_PREFIX = 'Which one do you mean?';
export const WAY_OUT_PREFIX = 'Which way out?';
/** Words that mean leaving the named place ("I leave the Drowned Rat", "flee out of town"). */
export const LEAVING_RE = /\b(leave|leaves|leaving|out|exit|exits|exiting|flee|flees|fleeing|fled|escape|escapes|escaping|get away)\b/i;
/** (a) unknown place: "You're not aware of such a place."  (b) known place, no allowed route: "You don't know a way to X from here." */
export const noticePrefix = noRoute => noRoute ? `You don't know a way to ${noRoute} from here.` : "You're not aware of such a place.";
export const unreachableText = (loc, noRoute = null) => `${noticePrefix(noRoute)} ${exitsText(loc)}`;
export const whichText = (cands, prefix = WHICH_PREFIX) => `${prefix} ${cands.map(x => x.label).join(', ')}`;

/**
 * Display-only game message: a system message, which SillyTavern never puts in the prompt.
 * kind 'which' lists candidate buttons; otherwise the not-aware / no-route text plus exit buttons.
 * Everything needed to rebuild the buttons is stored on the message, so they survive reloads.
 */
const noticeCands = candidates => candidates.map(x => ({ label: x.label, name: x.name, ...(x.direction ? { direction: x.direction } : {}), ...(x.prefix ? { prefix: x.prefix } : {}), address: x.address }));
/** The text addNotice shows for these options (also the error a failed typed move stamps on the player's message). */
export function noticeMes({ loc, noRoute = null, kind = 'unreachable', candidates = [], name = '', prefix = WHICH_PREFIX, text = '' }) {
    return kind === 'text' ? text : kind === 'which' ? whichText(noticeCands(candidates), prefix) : kind === 'already' ? alreadyText(loc, name) : unreachableText(loc, noRoute);
}
async function addNotice({ loc, noRoute = null, kind = 'unreachable', candidates = [], name = '', prefix = WHICH_PREFIX, text = '' }) {
    const c = ctx();
    const which = kind === 'which';
    const cands = noticeCands(candidates);
    const msg = {
        name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(),
        mes: noticeMes({ loc, noRoute, kind, candidates, name, prefix, text }),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: kind, worldscrawl_notice_loc: loc?.address ?? null,
            worldscrawl_notice_prefix: kind === 'text' ? '' : which ? prefix : kind === 'already' ? `You're already in ${name}.` : noticePrefix(noRoute), ...(which ? { worldscrawl_notice_candidates: cands } : {}) },
    };
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
}

const PLAIN_DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w', 'up', 'down', 'in', 'out', 'inside', 'outside', 'back', 'forward', 'left', 'right']);
const withArticle = name => (/^(the|a|an)\s/i.test(name) || /^[A-Z][\w-]*'s\s/.test(name) ? name : `the ${name}`);
/**
 * Where exactly the party arrived, room before building, so the model doesn't put them in the building's main room:
 * "arrives in the Stable of The Drowned Rat, entering through the gate (not the Common Room or any other part of
 * The Drowned Rat)". Built only from the room the server returned.
 */
export function arrival(loc, move) {
    const sub = loc.subregion ?? {};
    const room = loc.name;
    const where = sub.name && sub.name !== room && !sub.label_rooms ? `${withArticle(room)} of ${sub.name}` : room;
    const subOf = a => String(a ?? '').split('/')[0];
    const newBuilding = !!move?.from && subOf(move.from) !== subOf(loc.address);
    const dir = move?.last_direction ?? move?.direction;
    let text = `arrived in ${where}`; // past tense: reads right after "You" or "Ana and Hesk" (R4 N2)
    if (newBuilding && dir && !PLAIN_DIRECTIONS.has(String(dir).toLowerCase())) text += `, entering through the ${dir}${move.prev_name ? ` from ${move.prev_name}` : ''}`;
    let not = '';
    if (newBuilding && sub.name && sub.name !== room && sub.entrance && sub.entrance !== loc.address)
        not = ` They are in ${withArticle(room)}, not ${withArticle(sub.entrance_name ?? 'main room')} or any other part of ${sub.name}`;
    return { text: text + (not ? '.' + not : ''), where };
}

/** Short last-line reminder for move/travel turns (empty otherwise). */
export function arrivalReminder(loc, move) {
    if (!move || move.to !== loc.address) return '';
    const where = arrival(loc, move).where;
    return P('narration.arrival_reminder', { where });
}

/** "out", "up", "north"...: a direction, not a thing you can look through. */
export const isDirWord = d => PLAIN_DIRECTIONS.has(String(d ?? '').toLowerCase());
/** Directions that read after the noun: "the door out", "the door up" (R5 N5). */
const DOOR_AFTER = new Set(['up', 'down', 'in', 'out', 'inside', 'outside', 'forward']);
/** An exit as the narrator names it (the line adds "the"): "north door", "back door", "door out"; a named exit as it is ("trapdoor", "window"). */
export const doorWord = d => (!isDirWord(d) ? String(d ?? '') : DOOR_AFTER.has(String(d).toLowerCase()) ? `door ${d}` : `${d} door`);
/** A named exit that is not already a door-like thing gets "door" after it, for the door line ("cellar door"). */
const DOORISH = /\b(?:door|doors|gate|gates|hatch|grate|grille|portcullis|shutters?|window|curtain|trapdoor)\b/i;
const doorNoun = d => (isDirWord(d) || DOORISH.test(String(d ?? '')) ? doorWord(d) : `${d} door`);
/** "up", "out", "through the archway": how a look or a glimpse goes, as the narrator lines word it. */
const towards = d => (isDirWord(d) ? d : `through the ${d}`);
const farPiece = sight => (sight === 'clear' ? ` ${P('narration.view_far')}` : '');
/** The stay-put line for a turn with no move (narration.stay_put; R4's grammar-safe wording, R5 N7). */
export const stayPutLine = (who, here) => P('narration.stay_put', { party: who, place: here });
/** One line per thing visible from here: open exits (glimpse of the room beyond) and window views. */
export function glimpseLines(loc, open = new Map()) {
    const out = [];
    for (const e of loc.exits ?? []) {
        if (!revealsDestination(e) || !e.to_summary) continue;
        const sight = sightOf(e, open), sound = soundOf(e, open), closed = !isOpenNow(e, open), name = e.to_label ?? e.to_display_name ?? e.to_name;
        if (sight !== 'none') out.push(closed
            ? P('narration.glimpse_closed', { name, door: doorWord(e.direction), description: e.to_summary, far: farPiece(sight) })
            : P('narration.glimpse_open', { name, direction: towards(e.direction), description: e.to_summary, far: farPiece(sight) }));
        else if (closed && sound === 'clear') out.push(P('narration.glimpse_sound', { name, door: doorWord(e.direction) }));
    }
    for (const v of loc.views ?? []) out.push(P('narration.view', { name: v.display_name, description: v.summary }));
    return out;
}
/** The "what just happened" line for a look result (narration.look_* / listen_*). */
export function lookText(who, here, look) {
    const direction = look.window ? 'out' : look.via ? towards(look.via) : 'around';
    const door = doorWord(look.via);
    const opened = look.opened ? `${P('narration.look_opened', { party: who, door })} ` : '';
    const base = { party: who, place: here, door };
    if (look.kind === 'see' && look.peek) return P('narration.look_peek', { ...base, name: look.name, description: look.description });
    if (look.kind === 'see' && look.through_closed) return P('narration.look_through', { ...base, name: look.name, description: look.description });
    if (look.kind === 'see') return P('narration.look_see', { ...base, opened, direction, name: look.name, description: look.description, far: farPiece(look.sight) });
    if (look.kind === 'threshold') {
        const how = look.through_closed ? `through the closed ${door}` : look.peek ? `through a gap in the closed ${door}` : look.shut ? `at the closed ${door}` : direction;
        const beyond = look.unknown ? P('narration.look_beyond_unknown') : look.name ? P('narration.look_beyond_named', { name: look.name }) : P('narration.look_beyond_unseen');
        return P('narration.look_threshold', { ...base, opened, direction: how, description: look.description, beyond });
    }
    if (look.kind === 'closed' && look.stuck) return P('narration.door_stuck', { ...base, why: look.stuck });
    if (look.kind === 'closed') return P(look.word === 'way' ? 'narration.look_blocked' : 'narration.look_closed', base);
    if (look.kind === 'listen') return P(look.sound === 'clear' ? 'narration.listen_clear' : look.sound === 'none' ? 'narration.listen_none' : 'narration.listen_faint', base);
    return P('narration.look_nothing', { ...base, opened, direction });
}
export const LOOK_AROUND_RE = /\b(?:look(?:s|ed|ing)?|glanc(?:e|es|ed|ing)|gaz(?:e|es|ed|ing)|peer(?:s|ed|ing)?)\s+(?:around|about|round)\b|\b(?:survey(?:s|ed|ing)?|take(?:s)? in) (?:the|my|our) surroundings\b/i;
/** The narration line for a door that is not on the map yet: open it only if it fits the room. The story does not say how to flag it. */
export const newDoorLine = (who, place) => P('narration.new_door', { party: who, place });
/** Which failed attempt this turn carries (dig, stuck look, stuck door), in that precedence, or ''. */
function attemptKind(extra = {}) {
    if (extra.digFailed && !extra.dig) return 'dig';
    if (extra.look && extra.look.kind === 'closed' && extra.look.stuck) return 'look';
    if (extra.door?.type === 'stuck') return 'door';
    return '';
}
/**
 * The engine's result for a failed attempt, as fact, for the after-message slot (right after the player's message, with the
 * arrival reminder): one line for the first case that applies, none on a move turn. Same inputs as factsText's `extra`.
 */
export function attemptLines(loc, move, extra = {}) {
    if (move) return [];
    const who = partyText(), place = displayName(loc), kind = attemptKind(extra);
    if (kind === 'dig') return [P('narration.dig_failed', { party: who, place })];
    if (kind === 'look') return [P('narration.door_stuck', { party: who, door: doorWord(extra.look.via), why: extra.look.stuck, place })];
    if (kind === 'door') return [P(extra.door.attempt === 'move' ? 'narration.door_stuck_move' : 'narration.door_stuck', { party: who, door: doorWord(extra.door.direction), why: extra.door.why, place })];
    return [];
}
/** The time line: the game time, how long a move or journey took (in words), and the time-of-day nudge when it applies. */
function timeLine(move, extra) {
    if (!extra.date) return '';
    const took = move?.seconds ? ` ${P(move.path?.length > 2 ? 'narration.journey_took' : 'narration.move_took', { duration: durationWords(move.seconds) })}` : '';
    // R4 N8: the time-of-day nudge only when the caller says so (applyFacts: a move, a wait, or a new part of the day).
    return `${P('narration.time', { date: extra.date })}${took}${extra.timeNudge ? ` ${P('narration.time_nudge')}` : ''}`;
}
export function factsText(loc, move, toolsOn, extra = {}) {
    // The third argument still means "movement tools" for older callers. The story prompt does not tell the narrator how to report changes.
    const moveTools = extra.moveTools != null ? !!extra.moveTools : !!toolsOn;
    const who = partyText();
    const place = displayName(loc);
    const lines = [
        P('narration.header'),
        P('narration.location', { place: `${loc.name}${loc.subregion?.name && loc.subregion.name !== loc.name ? `, ${loc.subregion.name}` : ''}${loc.region?.name ? ` (${loc.region.name})` : ''}`, description: loc.description ?? '' }),
        extra.lore_index || '',
        extra.lore_fed || '',
        P('narration.exits', { exit_list: exitsText(loc).replace(/^Exits:\s*/, '') }),
        ...glimpseLines(loc, extra.open),
        timeLine(move, extra),
        extra.weather ? P('narration.weather', { weather: extra.weather }) : '',
        (extra.npcs_present || extra.npc_focus) ? P('narration.npcs', { npcs_present: extra.npcs_present || '(none)', npc_focus: extra.npc_focus || '' }) : '',
    ];
    const arr = move && move.to === loc.address ? arrival(loc, move) : null;
    const arrivalText = arr ? ` ${who} ${arr.text}.` : '', where = arr?.where ?? move?.to_name;
    if (extra.dig && move && move.to === loc.address) lines.push(P('narration.dig_through', { party: who, direction: extra.dig.direction, from: move.from_name, arrival: arrivalText, where }));
    else if (move?.path?.length > 2) lines.push(P('narration.travel', { party: who, from: move.path[0], via: move.path.slice(1, -1).join(', '), to: move.to_name, cut_short: move.stopped ? P('narration.travel_cut_short') : '', arrival: arrivalText, where }));
    else if (move) lines.push(P('narration.move', { party: who, direction: move.direction, from: move.from_name, to: move.to_name, arrival: arrivalText, where }));
    // A failed attempt (a failed dig, a stuck door looked at, opened or walked into) outranks any other note on the turn. Its
    // line goes after the player's message (attemptLines, the after-message slot); the facts block keeps only the stay-put line.
    else if (attemptKind(extra)) { /* attemptLines */ }
    else if (extra.look && extra.look.kind !== 'around') lines.push(lookText(who, place, extra.look));
    else if (extra.newDoor) lines.push(newDoorLine(who, place));
    else if (extra.door) lines.push(P('narration.door', { party: who, verb: ({ open_door: 'opened', close_door: 'closed', bar_door: 'barred', unbar_door: 'unbarred' })[extra.door.type] ?? 'closed', door: doorNoun(extra.door.direction), place }));
    else if (extra.dig) lines.push(P('narration.dig_here', { party: who, direction: extra.dig.direction, to: extra.dig.to_name, place }));
    else if (extra.lookAround || extra.look?.kind === 'around') lines.push(P('narration.look_around', { party: who, place }));
    // R5 N1: the other things that just happened (a temporary place that ran out, the place gone, the map changed around
    // the party, a wait, people back as they were) come next, before the stay-put line and the rules, so the rules stay last.
    lines.push(...(extra.happened ?? []));
    if (!move) lines.push(stayPutLine(who, place));
    if (move?.traversal?.length && move.to === loc.address) lines.push(P('narration.on_the_way', { steps: move.traversal.join(' Then: ') }));
    if ((move && move.to === loc.address) || ((extra.lookAround || extra.look?.kind === 'around') && !move)) lines.push(P('narration.exits_hint'));
    lines.push(moveTools ? P('narration.rules_tools') : P('narration.rules', { party: who }));
    return renderTokens(lines.filter(Boolean).join('\n'), { keepGate: true });
}

export { PLAIN_DIRECTIONS, addNotice, withArticle };
