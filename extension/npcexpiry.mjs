// Temporary person changes that ran out. Place expiries come from the map's patches (expiredBetween);
// people keep theirs as stamps on messages (appearance owners with start/lasts, and temporary facts).
// The engine drops an elapsed one from the replay by itself; this module names it, so the narrator,
// the tracker, the chat notice and a wait's summary all hear about it once.
import { NPC_KEY, lastsMinutes, nameKnown } from './npc.mjs';
import { isOwnerStamp } from './replay.mjs';

export const NPC_EXPIRED_KIND = 'npc_expired';
const isStory = m => !!m && !m.is_user && !m.is_system;
const stampsOf = m => {
    const active = m?.swipe_id ?? 0;
    return (Array.isArray(m?.extra?.[NPC_KEY]) ? m.extra[NPC_KEY] : []).filter(s => s && typeof s === 'object' && s.off !== true && (s.swipe == null || s.swipe === active));
};
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Temporary person changes that run out after game time `before` and by `after` (seconds), in the order they end:
 * [{key, id, kind: 'appearance'|'fact', what, ends, msg}]. `clock(i)` is the elapsed game time after message i
 * (a temporary fact starts at its message's time; an appearance owner carries its own start).
 */
export function personExpiriesBetween(chat, before, after, clock) {
    const out = [];
    if (!Number.isFinite(after)) return out;
    (chat ?? []).forEach((m, i) => {
        for (const s of stampsOf(m)) {
            if (isOwnerStamp(s)) {
                if (!s.committed || !(s.lasts > 0) || !Number.isFinite(s.start)) continue;
                const ends = s.start + s.lasts * 60;
                if (ends > before && ends <= after) out.push({ key: `own:${s.owner || s.identity?.owner}`, id: s.id, kind: 'appearance', what: clip(s.committed.intent || s.committed.text || s.intent || 'a change to how they look', 160), ends, msg: i });
            } else if (s.type === 'npc_fact' && s.pending !== true) {
                const lasts = lastsMinutes(s.lasts);
                if (!lasts) continue;
                let start = null;
                try { start = clock?.(i); } catch { start = null; }
                if (!Number.isFinite(start)) continue;
                const ends = start + lasts * 60;
                if (ends > before && ends <= after) out.push({ key: `fact:${m.extra?.worldscrawl_mid || i}:${s.text}`, id: s.id, kind: 'fact', what: clip(s.text, 160), ends, msg: i });
            }
        }
    });
    return out.sort((a, b) => a.ends - b.ends);
}

/**
 * The stretch of game time the next story reply (or the tracker reading reply `end`) has not narrated yet:
 * from just before the latest story reply before `end`, to message `end`. A change that ran out before the
 * narrator last spoke is old news; one that ran out on that reply's own wait, or after it, is not.
 */
export function expiryWindow(chat, end, clock) {
    let last = -1;
    for (let i = Math.min(end, (chat?.length ?? 0)) - 1; i >= 0; i--) if (isStory(chat[i])) { last = i; break; }
    let after = NaN, before = -Infinity;
    try { after = clock(end); } catch { after = NaN; }
    if (last >= 1) { try { const b = clock(last - 1); if (Number.isFinite(b)) before = b; } catch { /* no clock */ } }
    return { before, after };
}

/** How to name the person: the real name, plus how the player knows them while the name is unknown. */
export function whoText(n, party = 'the player') {
    const name = n?.name || n?.id || 'someone';
    if (n && !nameKnown(n).known && n.unknownAs) return `${name} (known to ${party} only as "${n.unknownAs}")`;
    return name;
}

/** Each expiry with the person as they are now (live Body/Outfit/Looks after the revert). `person(id)` folds them. */
export function describeExpiries(items, person, party) {
    return (items ?? []).flatMap(it => {
        const n = person(it.id);
        if (!n) return [];
        return [{ ...it, name: n.name || it.id, who: whoText(n, party), looks: n.looks || '', body: n.body || '', outfit: n.outfit || '' }];
    });
}

/** "the temporary change "turned into a gnoll" on Hesk": one item, for lists (a wait's summary, the tracker). */
export const changeLabel = it => `the temporary ${it.kind === 'fact' ? 'detail' : 'change'} "${it.what}" on ${it.who || it.name || it.id}`;

/** The chat notice text, worded like a place expiry's "[Engine: ...]" line. */
export function expiryNoticeText(items) {
    const parts = (items ?? []).map(it => `${it.who}: "${it.what}" ran out.${it.kind === 'appearance' && it.looks ? ` Looks now: ${it.looks}` : ''}`.replace(/\.\.$/, '.'));
    return `[Engine: ${parts.join(' ')}]`;
}

/** The narrator's one-time note: who changed back, and what they look like now, so the next reply gets it right. */
export function expiryNarratorNote(items, party = 'the player') {
    if (!items?.length) return '';
    const lines = items.map(it => {
        if (it.kind === 'fact') return `- ${it.who}: "${it.what}" was temporary and no longer holds.`;
        const now = [it.looks && `Looks: ${it.looks}`, it.body && `Body: ${it.body}`, it.outfit && `Outfit: ${it.outfit}`].filter(Boolean).join(' ');
        return `- ${it.who}: the temporary change "${it.what}" ran out and is gone; they are back to how they looked before it.${now ? ` What they look like now: ${now}` : ''}`;
    });
    return `Engine note (already applied; this is the same person, not someone new): while time passed, these temporary changes to people ran out:\n${lines.join('\n')}\nIf ${party} can see them, describe them as they are now.`;
}

/** The tracker's list of what the engine already did, so a story that narrates it is not reported again. */
export function trackerExpiryLines(items) {
    if (!items?.length) return '(none)';
    return items.map(it => `${it.name} [${it.id}]: ${changeLabel(it).replace(/^the/, 'The')} ran out; the game already changed them back. The Body and Outfit listed above are the result.`).join('\n');
}

/** Keys of the expiries a notice in this chat already announced. */
export function noticedExpiries(chat) {
    const out = new Set();
    for (const m of chat ?? []) if (m?.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND) for (const p of m.extra.worldscrawl_notice_people ?? []) if (p?.key) out.add(`${p.key}@${p.ends}`);
    return out;
}
export const expiryKey = it => `${it.key}@${it.ends}`;
