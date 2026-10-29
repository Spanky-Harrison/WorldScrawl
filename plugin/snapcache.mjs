// Map snapshot cache: a throwaway, always-rebuildable copy of the built map, so long chats don't replay every change on
// every request. Nothing is saved anywhere: the chat stays the only source of truth, and clearing the cache (Debug >
// Clear map cache, POST /cache/clear, or a server restart) only costs one full replay.
// Actor positions are not in this snapshot. They are stamps on messages, resolved afterwards against this one built
// world (every actor shares it). A world served from the cache matches a full replay of the same changes.
//
// Keys. A snapshot after the first i changes is keyed by a hash chain over the world id + version and the active changes
// (each change's stamp: message index _msg, swipe, id, ops... hashed as stable JSON). The active changes are the chat's
// changes with turned-off ones and ops expired at the game clock `now` left out, so the clock is part of every key.
// Each snapshot also records `expires`: the earliest "lasts" end still ahead of the clock among the ops it contains;
// once the clock reaches it the snapshot is never served (the replay rebuilds from the nearest earlier checkpoint).
//
// Checkpoints. While replaying, a snapshot is kept every CHECKPOINT_EVERY changes (and at the end). A request finds the
// longest prefix of its active changes that has a valid checkpoint and replays only the rest. Editing, deleting or
// swiping message k changes the hashes from k on, so everything before k is reused; an expiry at op j changes the
// active list from that change on, likewise.
import crypto from 'node:crypto';
import { apply_changes } from './changes.mjs';
import { activeChanges, parseLasts } from './ui/patches.mjs';

export const CHECKPOINT_EVERY = 25;
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const stable = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const sha = s => crypto.createHash('sha1').update(s).digest('base64url');

/** The earliest "lasts" end after `now` among these (active) changes; Infinity when nothing will expire or there's no clock. */
export function nextExpiry(changes, now) {
    if (now === null || now === undefined) return Infinity;
    let best = Infinity;
    for (const c of changes ?? []) {
        if (c?.type !== 'patch' || !Array.isArray(c.ops) || !Number.isFinite(Number(c.at))) continue;
        for (const op of c.ops) {
            if (!isObj(op) || !Object.hasOwn(op, 'lasts')) continue;
            let end; try { end = Number(c.at) + parseLasts(op.lasts); } catch { continue; }
            if (end > now && end < best) best = end;
        }
    }
    return best;
}

export class SnapshotCache {
    constructor({ maxCheckpoints = 400, every = CHECKPOINT_EVERY } = {}) {
        this.max = maxCheckpoints; this.every = every;
        this.map = new Map(); // hash -> {i, wj, raw, patches, failed, expires}
        this.stats = { hits: 0, partial: 0, misses: 0, replayed: 0, cleared: 0 };
    }
    clear() { const n = this.map.size; this.map.clear(); this.stats.cleared++; return n; }
    info() { return { checkpoints: this.map.size, every: this.every, ...this.stats }; }
    #put(h, v) { this.map.delete(h); this.map.set(h, v); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
    /**
     * The world JSON + region JSON with the chat's changes applied at game time `now`, and the replay info
     * ({patches, failed}, indexes into the active list). Same result as apply_changes(base, activeChanges(changesIn, now),
     * {now, lenient: true}), replaying only what follows the nearest valid checkpoint.
     * Returns {wj, raw, info, changes (the active list), key, from (the checkpoint used), expires}.
     */
    build(worldKey, baseWj, baseRaw, changesIn, now = null) {
        const changes = activeChanges(changesIn, now);
        const hashes = [sha(`ws-map\u0000${worldKey}`)];
        for (const c of changes) hashes.push(sha(`${hashes[hashes.length - 1]}\u0000${stable(c)}`));
        const n = changes.length, key = hashes[n];
        const usable = e => e && (now === null || now === undefined || now < e.expires);
        let from = 0, start = null;
        for (let i = n; i > 0; i--) { const e = this.map.get(hashes[i]); if (usable(e)) { from = i; start = e; break; } if (e) this.map.delete(hashes[i]); }
        if (start && from === n) {
            this.stats.hits++; this.#put(key, start);
            return { wj: start.wj, raw: start.raw, info: { patches: [...start.patches], ...(start.failed.length ? { failed: [...start.failed] } : {}) }, changes, key, from, expires: start.expires };
        }
        if (start) this.stats.partial++; else this.stats.misses++;
        this.stats.replayed += n - from;
        const info = { patches: start ? [...start.patches] : [], ...(start?.failed.length ? { failed: [...start.failed] } : {}) };
        const snap = (i, wj, raw) => {
            if (i === from || (i % this.every !== 0 && i !== n)) return;
            const done = changes.slice(0, i);
            const v = { i, wj: i === n ? structuredClone(wj) : wj, raw: i === n ? structuredClone(raw) : raw, patches: info.patches.filter(p => p.index < i),
                failed: (info.failed ?? []).filter(f => f.index < i), expires: nextExpiry(done, now) };
            this.#put(hashes[i], v);
        };
        const [wj, raw] = apply_changes(start?.wj ?? baseWj, start?.raw ?? baseRaw, changes, { now, info, lenient: true, from, onStep: snap });
        return { wj, raw, info, changes, key, from, expires: nextExpiry(changes, now) };
    }
}
