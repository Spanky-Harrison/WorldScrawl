// The name portal: every person name the model sees, and every name or id the model (or the player) sends back, goes
// through here. Outbound, a person the player has not learned the name of is their unknownAs ("the landlady"), and the
// model never sees a cast id: it sees a per-chat opaque handle ("p7k2"). Inbound, a handle, id, name, alias or
// unknownAs resolves to one person. Known-ness is read from the folded stamps at a message (never stored), so Undo and
// Turn off on a name stamp take effect at once. Pure: no DOM, fetch or model calls.

import { npc } from './shared.mjs';

const { nameIn, normName } = npc;
export const PLAYER = 'player';

// The wiring index.js gives the portal: the chat's Reveal names switch, the handle salt (the chat), and the map's
// place names (left untouched by masking: "Hesk's Room" is a place, not a person).
let wiring = { reveal: () => false, salt: () => '', places: () => [] };
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

/**
 * The person `text` means in `people`: an opaque handle or a cast id first, then an exact name, alias or unknownAs
 * (with or without "the"), then a name or alias contained either way, or the words inside an unknownAs. Null when none
 * or several match: no match rather than the wrong person. A made-up id ("mo-ran", "elara") is read as text.
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
    const key = normName(said), bare = bareName(said);
    if (!key) return null;
    const exact = list.filter(p => namesOf(p).some(n => normName(n) === key) || (p.unknownAs && bareName(p.unknownAs) === bare));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const loose = list.filter(p => namesOf(p).some(n => nameIn(said, n) || nameIn(n, said)) || (p.unknownAs && bare && !ARTICLE.test(`${bare} `) && nameIn(p.unknownAs, bare)));
    return loose.length === 1 ? loose[0] : null;
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
 */
export function judgeLearn({ person, present = [], heard = '', said = '', story = '' } = {}) {
    if (!person) return { ok: false, reason: 'no saved person matched' };
    if (!present.some(p => p.id === person.id)) return { ok: false, reason: `${person.name} is not here` };
    if (relOf(person).state === 'named' || !person.unknownAs) return { ok: false, reason: `the player already knows ${person.name}'s name` };
    if (!isNameOf(person, heard)) return { ok: false, reason: `"${String(heard ?? '').trim()}" is not ${person.name}'s name` };
    const name = namesOf(person).find(n => nameIn(heard, n) || normName(n) === normName(heard)) ?? heard;
    const spoken = [String(said ?? ''), ...spokenParts(story)].some(t => nameIn(t, name));
    if (!spoken) return { ok: false, reason: `${person.name}'s name was not said in dialogue` };
    return { ok: true, reason: 'introduced in dialogue' };
}

// ---- Outbound text.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
const NPC_TOKEN = /\{\{\s*npc(!?)\s*:\s*([^{}\s]*)\s*\}\}/gi;

/**
 * Engine text for the model: every real name or alias of a person in `people` the player does not know becomes their
 * unknownAs (exact, case-sensitive, whole words; capitalized at a sentence start; place names are left alone), then
 * {{npc:id}} tokens render as the shown name and {{npc!:id}} (the portal's own gated line only) as the real name.
 * Unknown token ids render as the bare id ("someone" when empty) and go to `onUnknown`.
 */
export function maskText(text, people, { onUnknown = null } = {}) {
    const list = [...(people ?? [])].filter(p => p?.id);
    const byId = new Map(list.map(p => [String(p.id).toLowerCase(), p]));
    const tokens = [];
    // Tokens out first (so masking never touches an id), back in last.
    let out = String(text ?? '').replace(NPC_TOKEN, (_all, bang, id) => {
        const p = byId.get(String(id).toLowerCase());
        let v;
        if (p) v = bang ? (p.name || id) : shownName(p);
        else { onUnknown?.(id); v = id || 'someone'; }
        tokens.push(v);
        return `\u0001${tokens.length - 1}\u0001`;
    });
    const hidden = list.filter(p => p.unknownAs && !isKnown(p));
    if (hidden.length && out) {
        const places = safe(wiring.places, []).filter(x => typeof x === 'string' && x.trim());
        for (const p of hidden) {
            for (const n of namesOf(p)) {
                const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n.trim())}(?![\\p{L}\\p{N}_])`, 'gu');
                const guarded = places.filter(pl => pl.includes(n.trim()));
                out = out.replace(re, (m, at, all) => {
                    if (guarded.some(pl => { const i = all.lastIndexOf(pl, at); return i >= 0 && i <= at && i + pl.length >= at + m.length; })) return m;
                    const before = all.slice(0, at);
                    return !before.trim() || /[.!?:]\s*$|\n\s*$/.test(before) ? capFirst(p.unknownAs) : p.unknownAs;
                });
            }
        }
    }
    return out.replace(/\u0001(\d+)\u0001/g, (_all, i) => tokens[Number(i)] ?? '');
}

/** Unknown people whose real name or alias is in `text` (engine blocks only; the choke-point check). */
export function nameLeaks(text, people) {
    const t = String(text ?? '');
    const out = [];
    for (const p of people ?? []) {
        if (!p?.unknownAs || isKnown(p)) continue;
        const hit = namesOf(p).find(n => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n.trim())}(?![\\p{L}\\p{N}_])`, 'u').test(t));
        if (hit) out.push({ id: p.id, name: hit });
    }
    return out;
}
