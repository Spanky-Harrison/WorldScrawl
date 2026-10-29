// Copy of plugin/actors.mjs (the extension cannot import plugin files statically). Keep them the same; a test checks.
// Per-actor positions. There is no stored party: a party is the player plus whoever is following them.
// The player is the default actor ("player"). Nobody follows yet.
//
// A location stamp (message.extra.worldscrawl_location) is either:
//   a string address  — the player's position (every chat saved before per-actor positions, and still what we
//                       write when only the player moved), or
//   { actorId: address } — the actors that stamp moved. Actors not mentioned keep their earlier position.
// Reading a string as the player is permanent. positionsAt is a per-chat memo of a full replay of those stamps,
// the same idea as clockAt: a changed stamp rebuilds from there, and the memo must match the replay.

export const PLAYER = 'player';
export const LOC_KEY = 'worldscrawl_location';

const isAddr = v => typeof v === 'string' && v.length > 0;

/** Actor ids following the player. None yet: following will be stamps, not a stored party. */
export function followers() { return []; }

/** The party, in order: the player, then whoever is following them. */
export function partyIds() { return [PLAYER, ...followers()]; }

/**
 * One message's location stamp as {actorId: address}, or null when it isn't one.
 * A string is the player's position.
 */
export function readPositions(stamp) {
    if (isAddr(stamp)) return { [PLAYER]: stamp };
    if (stamp !== null && typeof stamp === 'object' && !Array.isArray(stamp)) {
        const out = {};
        for (const [k, v] of Object.entries(stamp)) if (typeof k === 'string' && k && isAddr(v)) out[k] = v;
        return Object.keys(out).length ? out : null;
    }
    return null;
}

/** The player's address on this stamp, or null. */
export const playerAddress = stamp => readPositions(stamp)?.[PLAYER] ?? null;

/** Addresses the party occupies on this stamp (the player, and followers when they have their own). */
export function partyAddresses(stamp) {
    const p = readPositions(stamp);
    if (!p) return [];
    const out = [];
    for (const id of partyIds()) if (p[id] && !out.includes(p[id])) out.push(p[id]);
    return out;
}

/**
 * Value to store. Player-only stays a string, so a chat that only moves the player is byte-for-byte the old stamp.
 * Any other actor makes it an object. Never a bare string for a non-player: a string is always the player.
 */
export function positionStamp(positions) {
    const entries = Object.entries(positions ?? {}).filter(([k, v]) => typeof k === 'string' && k && isAddr(v));
    if (entries.length === 1 && entries[0][0] === PLAYER) return entries[0][1];
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : null;
}

/** Set one actor on an existing stamp. Does not mutate the stamp. Player-only result is a string. */
export function placeStamp(stamp, actor, address) {
    const cur = { ...(readPositions(stamp) ?? {}) };
    if (typeof actor !== 'string' || !actor) return positionStamp(cur);
    if (isAddr(address)) cur[actor] = address;
    else delete cur[actor];
    return positionStamp(cur);
}

const cloneMap = m => {
    const out = {};
    for (const [k, v] of Object.entries(m ?? {})) out[k] = { address: v.address, index: v.index };
    return out;
};

/** Positions in effect after message `index`, by replaying every stamp. No memo. */
export function replayPositions(chat, index) {
    if (!Array.isArray(chat)) return {};
    const end = Math.min(index, chat.length - 1);
    const out = {};
    for (let i = 0; i <= end; i++) {
        const got = readPositions(chat[i]?.extra?.[LOC_KEY]);
        if (!got) continue;
        for (const [id, address] of Object.entries(got)) out[id] = { address, index: i };
    }
    return out;
}

const stampKey = m => {
    const s = m?.extra?.[LOC_KEY];
    if (typeof s === 'string') return `s:${s}`;
    if (s !== null && typeof s === 'object' && !Array.isArray(s)) return `o:${Object.keys(s).sort().map(k => `${k}=${s[k]}`).join('\0')}`;
    return '';
};

// Per chat array, like clockAt. keys[i] is the stamp on message i; maps[i] is positions after that message.
const posCache = new WeakMap();

/**
 * Positions in effect after message `index` (inclusive): { actorId: { address, index } }.
 * `index` on each entry is the message that last placed that actor. Redirects are the caller's job.
 * The memo matches replayPositions; editing a stamp rebuilds from that message on.
 */
export function positionsAt(chat, index) {
    if (!Array.isArray(chat)) return {};
    const end = Math.min(index, chat.length - 1);
    if (end < 0) return {};
    let c = posCache.get(chat);
    if (!c) posCache.set(chat, c = { keys: [], maps: [] });
    let stale = false;
    for (let i = 0; i <= end; i++) {
        const key = stampKey(chat[i]);
        if (!stale && c.keys[i] === key && c.maps[i]) continue;
        stale = true;
        const next = i === 0 ? {} : cloneMap(c.maps[i - 1] ?? {});
        const got = readPositions(chat[i]?.extra?.[LOC_KEY]);
        if (got) for (const [id, address] of Object.entries(got)) next[id] = { address, index: i };
        c.keys[i] = key;
        c.maps[i] = next;
    }
    if (stale) { c.keys.length = end + 1; c.maps.length = end + 1; }
    return cloneMap(c.maps[end]);
}

/** One actor's position after message `index`, or null. Defaults to the player. */
export function positionOf(chat, index, actor = PLAYER) {
    const hit = positionsAt(chat, index)[actor];
    return hit ? { address: hit.address, index: hit.index } : null;
}

/** Earlier stamped addresses for one actor before message `before`, newest first, without repeats. */
export function actorHistory(chat, before, actor = PLAYER) {
    const out = [], end = Math.min(before, chat?.length ?? 0);
    for (let i = end - 1; i >= 0 && out.length < 200; i--) {
        const a = readPositions(chat[i]?.extra?.[LOC_KEY])?.[actor];
        if (a && !out.includes(a)) out.push(a);
    }
    return out;
}
