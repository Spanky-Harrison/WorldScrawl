// After-reply bookkeeper. Hit 1 (the verb check) and hit 2 (the narrator) do not report state.
// This pass is one question. It reads the latest exchange plus the live fields it may change, not earlier chat.
import { render as P, nameIn, normName, text as Text } from './shared.mjs';
import { FOUND_KEY, NPC_KEY, NPC_WARN_KEY } from './npc.mjs';
import { judgeRewrite } from './arearewrite.mjs';
import { PLAYER, positionOf } from './actors.mjs';
import { turnStartOf } from './generations.mjs';
import { DOOR_OPEN_RE } from './looking.mjs';

export const TRACKER_SOURCE = 'tracker';
const FLAG_KEY = 'worldscrawl_flag';
const PATCH_KEY = 'worldscrawl_patches';
const WAIT_KEY = 'worldscrawl_wait';
const WAITCARD_KEY = 'worldscrawl_waitcard';
const EMPTY = Object.freeze({ place: null, people: [], wait: null });
const DISPOSITIONS = ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'];

const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A story reply the tracker should read. Slash commands, inspector/engine notices, and empty failures are not. A quiet player line still is. */
export function shouldTrackReply(msg, chat = [], id = 0) {
    if (!msg || msg.is_user || msg.is_system) return false;
    if (msg.extra?.worldscrawl_notice || msg.extra?.worldscrawl_engine) return false;
    if (!String(msg.mes ?? '').trim()) return false;
    if (newSwipePending(msg)) return false;
    // A greeting (or any reply with no player line before it) is not an exchange: nothing to read.
    const user = playerBefore(chat, id);
    if (!user) return false;
    if (/^\s*\//.test(String(user.mes ?? '')) && !user.extra?.worldscrawl_engine) return false;
    return true;
}
/** SillyTavern points swipe_id one past the last swipe while it writes a new one; mes still holds the old text. */
export function newSwipePending(msg) {
    return Array.isArray(msg?.swipes) && (msg.swipe_id ?? 0) >= msg.swipes.length;
}
function playerBefore(chat, id) {
    for (let i = Math.min(id, chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user && !m.is_system) return m;
    }
    return null;
}
/** The player line the tracker sees: the latest user message before this reply, including an engine arrival note. */
export function playerLineBefore(chat, id) {
    return String(playerBefore(chat, id)?.mes ?? '');
}

const bare = v => String(v ?? '').trim().replace(/\.+$/, '');
const textOf = v => bare(v) || '(none)';
const listOf = v => {
    const items = (Array.isArray(v) ? v : []).map(bare).filter(Boolean);
    return items.length ? items.join('; ') : '(none)';
};
/** The place line: the room name and the display name. "Uncommon Room" plus "Uncommon Room (The Uncommon Room)" reads as the display name. */
function placeTitle(placeName, displayName) {
    const name = String(placeName ?? '').trim();
    const display = String(displayName ?? '').trim();
    if (display && name && display !== name) return display.startsWith(name) ? display : `${name} (${display})`;
    return display || name || 'here';
}
/** One line per person: every field the tracker may write for someone who is here. */
export function trackerPeopleLines(people) {
    const lines = (people ?? []).map(p => {
        if (!p?.id && !p?.name) return '';
        const stance = bare(p.stance);
        const reason = bare(p.stanceReason);
        const stanceLine = !stance && !reason ? '(none)' : reason ? `${stance || '(none)'} (${reason})` : stance;
        const unnamed = p.nameKnown === false && bare(p.unknownAs);
        return [
            `${p.name || p.id} [${p.id || p.name}]${unnamed ? ' (name not yet known)' : ''}`, // name-ok: listedPeople gives the shown name and handle
            `Looks: ${textOf(p.looks)}`,
            `Body: ${textOf(p.body)}`,
            `Outfit: ${textOf(p.outfit)}`,
            `Known facts: ${listOf(p.facts)}`,
            `Memories: ${listOf(p.memory ?? p.memories)}`,
            `Stance toward the player: ${stanceLine}`,
        ].join('. ');
    }).filter(Boolean);
    return lines.join('\n') || '(none)';
}
/**
 * The scrap for the one after-reply question. The full place name, display name, description and exits (so arriving by one is not a discovery),
 * the time of day (npc.tracker_time) and the known weather, and each person here. No earlier chat. The time and weather are listed
 * so morning light or a foggy sky is not mistaken for a new fact about the room. `time`: {part, time} at the reply, or null.
 */
export function trackerScrap({ placeName = '', displayName = '', placeDescription = '', exits = '', time = null, weather = '', peopleLines = '(none)', engineLines = '' } = {}) {
    return [
        `This place: ${placeTitle(placeName, displayName)}`,
        `Description: ${String(placeDescription ?? '').trim() || '(none)'}`,
        `Exits: ${String(exits ?? '').trim() || '(none)'}`,
        ...(time?.part && time?.time ? [P('npc.tracker_time', { part: time.part, time: time.time })] : []),
        `Weather (known; not a reason to rewrite this place): ${weather ? clip(weather, 200) : '(none)'}`,
        `People here:\n${peopleLines || '(none)'}`,
        ...(engineLines && engineLines !== '(none)' ? [`Already done by the game (not new changes; do not report them):\n${engineLines}`] : []),
    ].join('\n');
}
export const trackerSys = () => P('npc.tracker_system');
export const trackerPrompt = ({ scrap, player, story }) => P('npc.tracker', { scrap, said: clip(player, 1500), story: clip(story, 2000), fact_rules: P('npc.fact_rules'), memory_rules: P('npc.memory_rules') });

/** A why that only restates that something was updated ("door status updated", "changed"). */
const STATUS_WHY_RE = /^(?:[\w-]+\s+){0,2}(?:status|state)?\s*(?:updated|changed)\.?$/i;
/** Words for passing scene state: light, time of day, fire in the hearth, smells, sounds, mood, a door left open or shut. */
const TRANSIENT_RE = /\b(?:light|lit|sun|sunlight|sunrise|sunset|dawn|dusk|morning|evening|night|dark|darkness|darker|shadows?|lamps?|candles?|lanterns?|fire|hearth|embers?|smells?|scents?|odou?rs?|aromas?|warm|warmth|warmer|cold|colder|chill|mood|atmosphere|quiet|silent|silence|noise|noisy|crowded|empty|busy|ajar|open|opened|closed|shut|swung)\b/i;
/** Words for a lasting physical change: any one keeps the place change. "burned down to embers" is the hearth, not the room. */
const LASTING_RE = /\b(?:burn(?:s|ed|t)? (?:down|out|away)(?! to (?:embers|ash|coals))|burnt|scorch\w*|charred|collaps\w*|smash\w*|shatter\w*|break|breaks|broke|broken|flood\w*|block\w*|barricad\w*|built|build\w*|destroy\w*|ruin\w*|spread\w*|crack\w*|torn|tore|splinter\w*|knocked|hole|removed|added|install\w*|portal|cave[sd]? in|bricked|boarded|nailed|rubble|wrecked|barred|barricaded|locked|bolted|chained|jammed|wedged|stuck|sealed|opened up)\b/i;
/** Every clause of the note names only passing scene state, and none names a lasting change. */
export function transientOnly(note) {
    const text = String(note ?? '').trim();
    if (!text || LASTING_RE.test(text)) return false;
    const clauses = text.split(/[;,.]|\band\b|\bwhile\b/i).map(s => s.trim()).filter(Boolean);
    return clauses.length > 0 && clauses.every(c => TRANSIENT_RE.test(c));
}
/** Did the engine move the player this turn (the place at this reply differs from the place before its turn started)?
 *  Counts a player move on the player line, ws_move in tools mode, and an automatic reply that tells an expiry. */
export function movedThisTurn(chat, at) {
    const start = turnStartOf(chat, at);
    const before = positionOf(chat, start - 1, PLAYER)?.address ?? null, now = positionOf(chat, at, PLAYER)?.address ?? null;
    return !!before && !!now && before !== now;
}
/** Why the tracker's place item is dropped before it becomes a card, or '' to keep it. */
export function placeDropReason(chat, at, place) {
    if (!place) return '';
    if (place.kind === 'discover' && movedThisTurn(chat, at) && !DOOR_OPEN_RE.test(playerLineBefore(chat, at))) return 'tracker discover dropped: arrival by an exit';
    if (place.kind !== 'discover' && transientOnly(place.note)) return `tracker place dropped: only passing scene state (${place.note})`;
    return '';
}
// ---- T2b, the ownership guard (no model call): is a tracker appearance or fact item really about the person it names?
/** Person nouns that make an unlisted rival owner ("a stranger", "the old sailor"). Tune from playtests. */
export const RIVAL_NOUNS = ['man', 'men', 'woman', 'women', 'girl', 'boy', 'lad', 'lass', 'youth', 'child', 'stranger', 'traveller', 'traveler',
    'guard', 'soldier', 'patron', 'customer', 'drinker', 'drunk', 'sailor', 'bargeman', 'fisherman', 'merchant', 'peddler', 'figure', 'newcomer',
    'servant', 'maid', 'farmer', 'hunter', 'priest', 'monk', 'beggar', 'thief', 'knight', 'rider', 'messenger', 'fellow', 'urchin'];
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'into', 'onto', 'over', 'under',
    'through', 'up', 'down', 'out', 'off', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'it', 'its', 'her', 'his', 'their',
    'she', 'he', 'they', 'them', 'him', 'now', 'new', 'very', 'all', 'some', 'who', 'that', 'this', 'as', 'than', 'so', 'not', 'no']);
const RIVAL_RE = new RegExp(`\\b(?:one of the|another|some|the|an|a) (?:[a-z'-]+ ){0,2}?(${[...RIVAL_NOUNS].sort((x, y) => y.length - x.length).join('|')})s?\\b`, 'g');
const PRONOUN_START = /^\W*(?:she|he|they|her|his|their)\b/i;
const stem = w => w.replace(/(?:ing|ed|es|s)$/, '');
const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && stem(a) === stem(b));
const bareTerm = t => normName(t).replace(/^(?:the|a|an) /, '');
/** What a person can be called in the story: the name once the player knows it, aliases, and unknownAs with or without its article. */
const termsOf = p => [...(p?.nameKnown === false ? [] : [p?.name]), ...(Array.isArray(p?.aliases) ? p.aliases : []), p?.unknownAs, p?.unknownAs ? bareTerm(p.unknownAs) : '']
    .filter(t => typeof t === 'string' && normName(t));
const namedIn = (text, p) => termsOf(p).some(t => nameIn(text, t));
/** The content words of the change: "her cloak is soaked through" gives cloak, soaked. */
export function intentWords(item) {
    return [...new Set(normName(item?.intent || item?.text || '').split(' ').filter(w => w.length > 2 && !STOP.has(w)))];
}
/**
 * The T2b guard for one tracker item (appearance or fact) on `person` ({name, aliases, unknownAs, nameKnown, label}).
 * `text` is the player's line and the narrator reply; `listed` is everyone else listed here. Returns {verdict, reason}:
 * keep when the person is named; drop when they are not and a rival (another listed person named, or "a stranger"-style
 * phrase that is nobody listed) shares a sentence with the change's words, or the sentence before a "she/he/they" one;
 * otherwise warn (pronouns only: no gender guessing).
 */
export function ownerCheck(item, person, text, listed = []) {
    const who = person?.label || person?.unknownAs || person?.name || 'this person';
    if (namedIn(text, person)) return { verdict: 'keep', reason: '' };
    const words = intentWords(item);
    const everyone = [person, ...listed].filter(Boolean);
    const known = everyone.flatMap(termsOf).map(bareTerm).filter(Boolean);
    const sentences = Text.splitSentences(text);
    const rivalIn = sentence => {
        const n = normName(sentence);
        const other = listed.find(p => namedIn(n, p));
        if (other) return other.label || other.unknownAs || other.name;
        for (const m of n.matchAll(RIVAL_RE)) {
            if (known.some(k => nameIn(m[0], k))) continue; // "the landlady" is never a rival while she is listed
            return `the ${m[1].replace(/^men$/, 'man').replace(/^women$/, 'woman')}`;
        }
        return '';
    };
    for (let i = 0; i < sentences.length; i++) {
        const has = normName(sentences[i]).split(' ').some(w => words.some(x => sameWord(w, x)));
        if (!has) continue;
        const rival = rivalIn(sentences[i]) || (i > 0 && PRONOUN_START.test(sentences[i]) ? rivalIn(sentences[i - 1]) : '');
        if (rival) return { verdict: 'drop', reason: `tracker item dropped: the change reads as ${possessive(rival)}, not ${possessive(who)}`, rival };
    }
    return { verdict: 'warn', reason: `This reply never names ${who}; check this change is really ${possessive(who)}.` };
}
const possessive = w => (/s$/i.test(w) ? `${w}'` : `${w}'s`);
export function readPlace(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (p.changed === false) return null;
    const note = String(p.note ?? p.text ?? '').trim();
    if (!note) return null;
    const kind = String(p.kind ?? 'change').toLowerCase() === 'discover' ? 'discover' : 'change';
    const hint = String(p.hint ?? p.where ?? '').trim();
    // Light touch or full rewrite (not "scope": a change's scope is which rooms): from rewrite, else from a why that leads
    // with the word. Kept only when judged; why only with it. `raw` is the tracker's place object as given, for diagnosis.
    const j = judgeRewrite(p.rewrite, p.why ?? p.rewrite_reason);
    if (j.why && STATUS_WHY_RE.test(j.why.trim())) j.why = ''; // "door status updated" says nothing: the card shows "Light touch" alone
    return { changed: true, kind, note: note.slice(0, 200), ...(hint ? { hint: hint.slice(0, 80) } : {}),
        ...(j.rewrite ? { rewrite: j.rewrite } : {}), ...(j.rewrite && j.why ? { why: j.why.slice(0, 200) } : {}), raw: p };
}
function readWait(w) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
    const duration = String(w.duration ?? w.amount ?? '').trim();
    const until = String(w.until ?? '').trim();
    const sleep = w.sleep === true || String(w.sleep).toLowerCase() === 'true' || String(w.sleep).toLowerCase() === 'sleep';
    const reason = String(w.reason ?? '').trim();
    if (!duration && !until && !sleep) return null;
    return { duration: duration.slice(0, 40), until: until.slice(0, 40), sleep, reason: reason.slice(0, 80) };
}
function readPerson(p) {
    if (!p || typeof p !== 'object') return null;
    const action = String(p.action ?? p.type ?? '').toLowerCase().trim();
    const id = String(p.id ?? p.who ?? '').trim();
    const name = String(p.name ?? '').trim(); // name-ok: inbound (tracker answer)
    if (!action) return null;
    if (action === 'found' || action === 'name') {
        const who = name || id;
        return who ? { action, id, name: who } : null;
    }
    if (!id && !name) return null;
    if (action === 'disposition' && !DISPOSITIONS.includes(String(p.value ?? '').toLowerCase())) return null;
    const item = { action, id: id || name };
    if (name) item.name = name;
    for (const k of ['intent', 'fields', 'lasts', 'text', 'value', 'reason', 'looks', 'body', 'outfit', 'scope', 'why']) {
        if (p[k] != null && String(p[k]).trim()) item[k] = String(p[k]).trim();
    }
    if (item.value) item.value = item.value.toLowerCase();
    return item;
}
function foldChange(list, into) {
    for (const c of list ?? []) {
        if (!c || typeof c !== 'object') continue;
        const type = String(c.type ?? c.kind ?? '').toLowerCase();
        if (type === 'place' || type === 'discover' || type === 'change') into.place ??= readPlace({ ...c, kind: type === 'discover' ? 'discover' : c.kind, changed: c.changed !== false });
        else if (type === 'wait' || type === 'sleep') into.wait ??= readWait({ ...c, sleep: type === 'sleep' || c.sleep });
        else {
            const person = readPerson(type === 'person' ? c : { ...c, action: c.action ?? type });
            if (person) into.people.push(person);
        }
    }
}
/**
 * The tracker's JSON: a place, any number of person updates, and a wait, together or empty.
 * `changes: []` is accepted as well as the place/people/wait object. Not prose. Text that is not JSON at all (empty,
 * prose, or cut off mid-object) comes back `unreadable: true`, so the read is marked failed instead of "nothing changed".
 */
export function readTrackerAnswer(ans) {
    if (typeof ans === 'string') {
        try { ans = JSON.parse(ans.replace(/```(?:json)?/gi, '').trim()); } catch { return { ...EMPTY, people: [], unreadable: true }; }
    }
    if (ans == null) return { ...EMPTY, people: [], unreadable: true };
    if (!ans || typeof ans !== 'object' || Array.isArray(ans)) return { ...EMPTY, people: [] };
    const out = { place: readPlace(ans.place), people: [], wait: readWait(ans.wait) };
    for (const p of Array.isArray(ans.people) ? ans.people : []) {
        const person = readPerson(p);
        if (person) out.people.push(person);
    }
    if (Array.isArray(ans.changes)) foldChange(ans.changes, out);
    return out;
}
/** Map-flag off drops place proposals. NPC-flag off drops person proposals. A wait is not gated by those checkboxes. */
export function gateTracker(parsed, { places = true, people = true } = {}) {
    const p = parsed ?? EMPTY;
    return { place: places ? (p.place ?? null) : null, people: people ? [...(p.people ?? [])] : [], wait: p.wait ?? null };
}

const stripList = (extra, key) => {
    if (!Array.isArray(extra[key])) return;
    const next = extra[key].filter(s => s?.source !== TRACKER_SOURCE);
    if (next.length) extra[key] = next; else delete extra[key];
};
function stripExtra(extra) {
    if (!extra || typeof extra !== 'object') return;
    stripList(extra, NPC_KEY);
    stripList(extra, NPC_WARN_KEY);
    stripList(extra, PATCH_KEY);
    stripList(extra, FOUND_KEY);
    if (extra[FLAG_KEY]?.source === TRACKER_SOURCE) delete extra[FLAG_KEY];
    if (extra[WAIT_KEY]?.source === TRACKER_SOURCE) delete extra[WAIT_KEY];
    if (extra[WAITCARD_KEY]?.source === TRACKER_SOURCE) delete extra[WAITCARD_KEY];
    delete extra[TRACKED_KEY]; // the read starts over
}
/** Remove tracker-written stamps from this message and every swipe copy. Pasted tags are left alone. */
export function dropTrackerMarks(msg) {
    if (!msg) return;
    stripExtra(msg.extra);
    for (const si of msg.swipe_info ?? []) stripExtra(si?.extra);
}

const gens = new WeakMap();
/** Bump so a tracker call still in flight cannot stamp a swipe the reader has left. */
export function bumpTracker(msg) {
    const n = (gens.get(msg) ?? 0) + 1;
    gens.set(msg, n);
    return n;
}
export const trackerGen = msg => gens.get(msg) ?? 0;

// ---- the tracked marker: a small line under the latest story reply saying the after-reply read is running or found
// nothing to add. The finished state is stored per swipe (survives a reload); "tracking…" is live only (a reload
// ends the read, so a stored "tracking…" would never finish).
export const TRACKED_KEY = 'worldscrawl_tracked';
const running = new WeakMap(); // msg -> {swipe, gen}
const swipeAt = m => m?.swipe_id ?? 0;
/** The read started on this swipe (gen: bumpTracker's number for it). attempt / of: which try this is, for the marker
 *  ("tracking… (try 2 of 3)"; of 0 when the number of tries is open, a Retry click: "tracking… (try 2)"). */
export function markTracking(msg, gen, { attempt = 1, of = 1 } = {}) { running.set(msg, { swipe: swipeAt(msg), gen, attempt, of }); }
/** The try the live read is on: {attempt, of}, or null when none is running on the swipe shown. */
export function trackTry(msg) {
    const r = running.get(msg);
    return r && r.swipe === swipeAt(msg) ? { attempt: r.attempt ?? 1, of: r.of ?? 1 } : null;
}
/** The read ended: 'tracked' (nothing to add), 'carded' (it put up a card, which stands in for the marker), 'failed',
 *  or null (stale or skipped: nothing stored). Only the read that is still current may end the live state. */
export function markTracked(msg, gen, status, { tries = 1, unreadable = false } = {}) {
    const r = running.get(msg);
    if (r && r.gen === gen) running.delete(msg);
    if (!status || !msg) return;
    msg.extra = msg.extra ?? {};
    msg.extra[TRACKED_KEY] = { swipe: swipeAt(msg), status, ...(tries > 1 ? { tries } : {}), ...(status === 'failed' && unreadable ? { unreadable: true } : {}) };
}
/** The stored failed read on the swipe shown ({status: 'failed', tries?, unreadable?}), or null. */
export function trackFailure(msg) {
    const t = msg?.extra?.[TRACKED_KEY];
    return trackMark(msg) === 'failed' && t ? t : null;
}
/** Did this read leave anything on the message (a card or a stamp the player sees)? */
export function hasTrackerCard(msg) {
    const e = msg?.extra ?? {}, swipe = swipeAt(msg), mine = x => x?.source === TRACKER_SOURCE && (x.swipe ?? 0) === swipe;
    return [NPC_KEY, NPC_WARN_KEY, PATCH_KEY, FOUND_KEY].some(k => (Array.isArray(e[k]) ? e[k] : []).some(mine))
        || [FLAG_KEY, WAIT_KEY, WAITCARD_KEY].some(k => mine(e[k]));
}
/** What the marker says for this message now: 'tracking' | 'tracked' | 'failed' | '' (nothing). */
export function trackMark(msg) {
    const r = running.get(msg);
    if (r && r.swipe === swipeAt(msg)) return 'tracking';
    const t = msg?.extra?.[TRACKED_KEY];
    if (!t || (t.swipe ?? 0) !== swipeAt(msg)) return '';
    return t.status === 'tracked' || t.status === 'failed' ? t.status : '';
}
