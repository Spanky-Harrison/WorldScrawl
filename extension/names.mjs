// The name portal: every person name the model sees, and every name or id the model (or the player) sends back, goes
// through here. Outbound, a person the player has not learned the name of is their unknownAs ("the landlady"), and the
// model never sees a cast id: it sees a per-chat opaque handle ("p7k2"). Inbound, a handle, id, name, alias or
// unknownAs resolves to one person. Known-ness is read from the folded stamps at a message (never stored), so Undo and
// Turn off on a name stamp take effect at once. Pure: no DOM, fetch or model calls.

import { npc } from './shared.mjs';

const { nameIn, normName } = npc;
export const PLAYER = 'player';

// The wiring scene.mjs gives the portal: the chat's Reveal names switch, the handle salt (the chat), the map's
// place names (left untouched by masking: "Hesk's Room" is a place, not a person), and the cast as it is now (people).
let wiring = { reveal: () => false, salt: () => '', places: () => [], people: () => [] };
export function configureNames(w = {}) { wiring = { ...wiring, ...w }; }
const safe = (f, d) => { try { return f() ?? d; } catch { return d; } };
export const revealNames = () => !!safe(wiring.reveal, false);

const relOf = (n, who = PLAYER) => n?.rel?.[who] ?? { state: 'unmet', at: null, by: '' };

/**
 * Whether actor `who` (the player unless given) knows person n's name, and why. Known when Reveal names is on, when
 * their relationship record says 'named' (an npc_name stamp, [remember], or the player's /ws-know edit), or when the
 * card has no unknownAs (nothing else to call them).
 */
export function knows(n, who = PLAYER) {
    if (revealNames()) return { known: true, reason: 'known: Reveal names is on' };
    const r = relOf(n, who);
    if (r.state === 'named') return { known: true, reason: `known: ${r.by}` };
    if (!n?.unknownAs) return { known: true, reason: 'known: no unknownAs on the card' };
    return { known: false, reason: `not known: shown as "${n.unknownAs}"` };
}
const isKnown = p => (revealNames() ? true : p?.known && typeof p.known === 'object' ? p.known.known !== false : knows(p).known);

/** The name the model may use for p: the real name once the player knows it, else unknownAs. */
export function shownName(p) {
    if (!p) return 'someone';
    return isKnown(p) || !p.unknownAs ? (p.name || 'someone') : p.unknownAs;
}

// ---- Opaque handles: stable per chat (salted with the chat), never the cast id.
function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
}
/** The handle the model sees for cast id `id` in this chat. */
export function handleOf(id) {
    if (!id) return '';
    return `p${fnv(`${safe(wiring.salt, '')}|${id}`).slice(0, 4)}`;
}
/** "the landlady [p7k2]" / "Hesk [p7k2]": how a prompt names a person it lists. */
export const labelOf = p => `${shownName(p)} [${handleOf(p?.id)}]`;

// ---- Inbound: text, handle or id -> one person.
const ARTICLE = /^(?:the|a|an) /;
const bareName = s => normName(s).replace(ARTICLE, '');
const namesOf = p => [p?.name, ...(Array.isArray(p?.aliases) ? p.aliases : [])].filter(x => typeof x === 'string' && x.trim());

/** Words that end the person part of what was typed: "the landlady behind the bar" is "the landlady". */
const PLACE_WORD = /\s+(?:behind|beside|by|near|next|at|in|inside|outside|on|under|over|with|from|across|around|among|between|into|through|toward|towards|upstairs|downstairs)\b.*$/;
/**
 * The person `text` means in `people`: an opaque handle or a cast id first, then an exact name, alias or unknownAs
 * (with or without "the"), then a name or alias contained either way, or an unknownAs that starts with the typed words
 * ("guard" -> "guard captain", never "guard captain" -> "guard"). Still nobody: the same with the text cut at its first
 * place word ("the landlady behind the bar" -> "the landlady"). Null when none or several match: no match rather than
 * the wrong person. A made-up id ("mo-ran", "elara") is read as text.
 */
export function findPerson(text, people) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const list = [...(people ?? [])].filter(Boolean);
    const byHandle = list.filter(p => handleOf(p.id) === raw);
    if (byHandle.length === 1) return byHandle[0];
    const byId = list.find(p => p.id === raw);
    if (byId) return byId;
    const said = raw.replace(/[_-]+/g, ' ');
    const hit = matchSaid(said, list);
    if (hit !== undefined) return hit;
    const cut = said.replace(PLACE_WORD, '').trim();
    return cut && cut !== said ? matchSaid(cut, list) ?? null : null;
}
/** One person for the words `said`, null for several (ambiguous: stop), undefined for none. */
function matchSaid(said, list) {
    const key = normName(said), bare = bareName(said);
    if (!key) return undefined;
    const exact = list.filter(p => namesOf(p).some(n => normName(n) === key) || (p.unknownAs && bareName(p.unknownAs) === bare));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const starts = d => { const b = bareName(d); return b === bare || b.startsWith(`${bare} `); };
    const loose = list.filter(p => namesOf(p).some(n => nameIn(said, n) || nameIn(n, said)) || (p.unknownAs && bare && !ARTICLE.test(`${bare} `) && starts(p.unknownAs)));
    return loose.length === 1 ? loose[0] : loose.length > 1 ? null : undefined;
}

// ---- Learning a name.
const QUOTED = /"([^"\n]*)"|“([^”]*)”/g;
/** The spoken parts of a reply: text inside double quotes. */
export function spokenParts(text) {
    const out = [];
    for (const m of String(text ?? '').matchAll(QUOTED)) out.push(m[1] ?? m[2] ?? '');
    return out;
}
/** Does `heard` name p (their real name or an alias, whole words)? */
export const isNameOf = (p, heard) => !!normName(heard) && namesOf(p).some(n => normName(n) === normName(heard) || nameIn(heard, n));

/**
 * The rules a model-sourced name learn must pass: `person` resolved, is present, the player does not know the name yet,
 * `heard` is their name or an alias, and that name was spoken in this exchange (inside quotes in the reply, or anywhere
 * in the player's own line). {ok, reason}. Player sources (bracket, /ws-name) skip the rules; see learnName in scene.mjs.
 * `saidOnly` (the player-line learn, learnSaidNames in scene.mjs): presence is not needed, and only the player's own
 * line counts as where the name was said.
 */
export function judgeLearn({ person, present = [], heard = '', said = '', story = '', saidOnly = false } = {}) {
    if (!person) return { ok: false, reason: 'no saved person matched' };
    if (!saidOnly && !present.some(p => p.id === person.id)) return { ok: false, reason: `${person.name} is not here` };
    if (relOf(person).state === 'named' || !person.unknownAs) return { ok: false, reason: `the player already knows ${person.name}'s name` };
    if (!isNameOf(person, heard)) return { ok: false, reason: `"${String(heard ?? '').trim()}" is not ${person.name}'s name` };
    const name = namesOf(person).find(n => nameIn(heard, n) || normName(n) === normName(heard)) ?? heard;
    const spoken = [String(said ?? ''), ...(saidOnly ? [] : spokenParts(story))].some(t => nameIn(t, name));
    if (!spoken) return { ok: false, reason: saidOnly ? `the player did not say ${person.name}'s name` : `${person.name}'s name was not said in dialogue` };
    return { ok: true, reason: saidOnly ? 'said by the player' : 'introduced in dialogue' };
}

// ---- Outbound text.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
const NPC_TOKEN = /\{\{\s*npc(!?)\s*:\s*([^{}\s]*)\s*\}\}/gi;
const nameRe = (n, flags = '') => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n.trim())}(?![\\p{L}\\p{N}_])`, `u${flags}`);
/** Is the match at `at` inside one of the map's place names ("Hesk's Room")? */
function inPlace(all, at, m) {
    return safe(wiring.places, []).some(pl => typeof pl === 'string' && pl.includes(m) && (() => { const i = all.lastIndexOf(pl, at); return i >= 0 && i <= at && i + pl.length >= at + m.length; })());
}

/**
 * Engine text for the model: every real name or alias of a person in `people` the player does not know becomes their
 * unknownAs (exact, case-sensitive, whole words; capitalized at a sentence start; place names are left alone), then
 * {{npc:id}} tokens render as the shown name and {{npc!:id}} (the portal's own gated line only) as the real name.
 * Unknown token ids render as the bare id ("someone" when empty) and go to `onUnknown`. `keepGate` leaves {{npc!:id}}
 * as is, for a block that is masked again at the prompt choke point (applyFacts).
 */
export function maskText(text, people, { onUnknown = null, keepGate = false } = {}) {
    const list = [...(people ?? [])].filter(p => p?.id);
    const byId = new Map(list.map(p => [String(p.id).toLowerCase(), p]));
    const tokens = [];
    // Tokens out first (so masking never touches an id), back in last.
    let out = String(text ?? '').replace(NPC_TOKEN, (all, bang, id) => {
        const p = byId.get(String(id).toLowerCase());
        if (bang && keepGate) { tokens.push(all); return `\u0001${tokens.length - 1}\u0001`; }
        let v;
        if (p) v = bang ? (p.name || id) : shownName(p);
        else { onUnknown?.(id); v = id || 'someone'; }
        tokens.push(v);
        return `\u0001${tokens.length - 1}\u0001`;
    });
    for (const p of list.filter(p => p.unknownAs && !isKnown(p))) {
        for (const n of namesOf(p)) {
            out = out.replace(nameRe(n, 'g'), (m, at, all) => {
                if (inPlace(all, at, m)) return m;
                const before = all.slice(0, at);
                return !before.trim() || /[.!?:]\s*$|\n\s*$/.test(before) ? capFirst(p.unknownAs) : p.unknownAs;
            });
        }
    }
    return out.replace(/\u0001(\d+)\u0001/g, (_all, i) => tokens[Number(i)] ?? '');
}

/** maskText against everyone in the cast as they are now: for engine-built side-call text (never story or player text). */
export const maskForModel = (text, opts = {}) => maskText(text, safe(wiring.people, []), opts);

/**
 * Unknown people whose real name or alias is in `text` outside a place name: the choke-point check, run on the final
 * engine block (with the portal's own gated lines taken out). [{id, name}].
 */
export function nameLeaks(text, people) {
    const t = String(text ?? '');
    const out = [];
    for (const p of people ?? []) {
        if (!p?.unknownAs || isKnown(p)) continue;
        const hit = namesOf(p).find(n => [...t.matchAll(nameRe(n, 'g'))].some(m => !inPlace(t, m.index, m[0])));
        if (hit) out.push({ id: p.id, name: hit });
    }
    return out;
}

/** Does `text` hold `name` as written (exact case, whole words) outside a place name? */
const writesName = (text, name) => { const t = String(text ?? ''); return [...t.matchAll(nameRe(name, 'g'))].some(m => !inPlace(t, m.index, m[0])); };
/**
 * The player-line learn's test: the real name or alias of p (not yet known to the player) that the player's own line
 * `said` uses (whole words, any case) and the narrator wrote earlier in `story` (earlier story replies, quoted or plain;
 * as written: exact case, whole words, outside a place name). The name, or '' when none.
 */
export function saidNameOf(p, said, story = []) {
    if (!p?.unknownAs || isKnown(p)) return '';
    return namesOf(p).find(n => nameIn(said, n) && story.some(t => writesName(t, n))) ?? '';
}
