// After-reply bookkeeper. Hit 1 (the verb check) and hit 2 (the narrator) do not report state.
// This pass is one question. It reads the latest exchange plus the live fields it may change, not earlier chat.
import { render as P } from './shared.mjs';
import { FOUND_KEY, NPC_KEY, NPC_WARN_KEY } from './npc.mjs';

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
    const user = playerBefore(chat, id);
    if (user && /^\s*\//.test(String(user.mes ?? '')) && !user.extra?.worldscrawl_engine) return false;
    return true;
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
        return [
            `${p.name || p.id} [${p.id || p.name}]`,
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
 * The scrap for the one after-reply question. The full place name, display name, and description,
 * the known weather, and each person here. No earlier chat. Weather is listed so a foggy sky is not
 * mistaken for a new fact about the room.
 */
export function trackerScrap({ placeName = '', displayName = '', placeDescription = '', weather = '', peopleLines = '(none)' } = {}) {
    return [
        `This place: ${placeTitle(placeName, displayName)}`,
        `Description: ${String(placeDescription ?? '').trim() || '(none)'}`,
        `Weather (known; not a reason to rewrite this place): ${weather ? clip(weather, 200) : '(none)'}`,
        `People here:\n${peopleLines || '(none)'}`,
    ].join('\n');
}
export const trackerSys = () => P('npc.tracker_system');
export const trackerPrompt = ({ scrap, player, story }) => P('npc.tracker', { scrap, said: clip(player, 1500), story: clip(story, 2000) });

function readPlace(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (p.changed === false) return null;
    const note = String(p.note ?? p.text ?? '').trim();
    if (!note) return null;
    const kind = String(p.kind ?? 'change').toLowerCase() === 'discover' ? 'discover' : 'change';
    const hint = String(p.hint ?? p.where ?? '').trim();
    return { changed: true, kind, note: note.slice(0, 200), ...(hint ? { hint: hint.slice(0, 80) } : {}) };
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
    const name = String(p.name ?? '').trim();
    if (!action) return null;
    if (action === 'found' || action === 'name') {
        const who = name || id;
        return who ? { action, id, name: who } : null;
    }
    if (!id && !name) return null;
    if (action === 'disposition' && !DISPOSITIONS.includes(String(p.value ?? '').toLowerCase())) return null;
    const item = { action, id: id || name };
    if (name) item.name = name;
    for (const k of ['intent', 'fields', 'lasts', 'text', 'value', 'reason', 'looks', 'body', 'outfit']) {
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
 * `changes: []` is accepted as well as the place/people/wait object. Not prose.
 */
export function readTrackerAnswer(ans) {
    if (typeof ans === 'string') {
        try { ans = JSON.parse(ans.replace(/```(?:json)?/gi, '').trim()); } catch { return { ...EMPTY, people: [] }; }
    }
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
