// The blanket position resolver: turns any location into a real room of the effective map.
// Used for the player after every effective-map rebuild, and exported for computed positions
// (e.g. future NPC schedules).
//
// Fallback chain, first hit wins:
//   1. 'here'        the address exists.
//   2. 'merged'      follow merge/removal redirects (patch `relocate` maps) to a room that exists.
//   3. 'restored'    reverse redirect: a room that was merged/removed into this one (a temporary
//                    change that has since expired) exists again.
//   4. 'neighbor'    a surviving room that the missing room's exits led to, using the latest
//                    previous map state where the room existed.
//   5. 'history'     the most recent earlier stamped position (newest first) that still exists, e.g. after
//                    swiping away the change that created the room.
//   6. 'subregion'   the entrance of the room's subregion, 6. 'region' the region entrance,
//   7. 'start'       the world start.

const MAX_HOPS = 32;

/**
 * @param {World} w            the effective (built) world
 * @param {string} address     the location to resolve
 * @param {object} opts
 *   relocate: {old: new}      merged redirect map (active changes)
 *   allRelocate: {old: new}   redirects of every change, expired ones included (for step 3)
 *   before: addr => World|null  latest previous map state in which addr existed
 *   history: [address]        earlier stamped positions, newest first
 * @returns {{address, moved, how, from}}
 */
export function resolvePosition(w, address, { relocate = {}, allRelocate = relocate, before = null, history = [] } = {}) {
    const ok = a => typeof a === 'string' && w.locations.has(a);
    const done = (a, how) => ({ address: a, moved: a !== address, how, from: address });
    if (ok(address)) return done(address, 'here');
    const follow = (a, map) => { const seen = new Set(); while (map[a] && !seen.has(a) && seen.size < MAX_HOPS) { seen.add(a); a = map[a]; } return a; };
    const fwd = follow(address, relocate);
    if (ok(fwd)) return done(fwd, 'merged');
    // Reverse: rooms that were folded into the missing address (or into where it leads).
    for (const target of new Set([address, fwd])) {
        const back = Object.keys(allRelocate).filter(k => follow(k, allRelocate) === target || allRelocate[k] === target).sort();
        const hit = (history ?? []).find(h => back.includes(h) && ok(h)) ?? back.find(ok); // the piece the party came from first
        if (hit) return done(hit, 'restored');
    }
    // Exits of the room in the last state where it existed.
    for (const a of new Set([address, fwd])) {
        const prev = typeof before === 'function' ? before(a) : null;
        const loc = prev?.locations.get(a);
        if (!loc) continue;
        // Back out through the exit the party came in by: the newest earlier position that one of its exits led to.
        for (const h of history ?? []) {
            const x = ok(h) && loc.exits.find(e => e.to === h);
            if (x) return { ...done(h, 'came_from'), via: x.direction };
        }
        for (const x of loc.exits) {
            const t = ok(x.to) ? x.to : follow(x.to, relocate);
            if (ok(t)) return { ...done(t, 'neighbor'), via: x.direction };
        }
    }
    for (const h of history ?? []) { const t = ok(h) ? h : follow(h, relocate); if (ok(t)) return done(t, 'history'); }
    const [region, rest = ''] = String(address).split(':');
    const subId = rest.split('/')[0];
    const sub = w.subregions.get(`${region}:${subId}`);
    if (sub && ok(sub.entrance)) return done(sub.entrance, 'subregion');
    const reg = w.regions.get(region);
    const re = reg?.entrance;
    if (ok(re)) return done(re, 'region');
    return done(w.start, 'start');
}

/** Merge the relocate maps of apply_changes' info.patches (only patches from message index `since` on). */
export function relocateMap(patches = [], since = null) {
    const out = {};
    for (const p of patches) {
        if (since !== null && p.msg !== null && p.msg !== undefined && p.msg < since) continue;
        for (const [k, v] of Object.entries(p.relocate ?? {})) {
            for (const [k2, v2] of Object.entries(out)) if (v2 === k) out[k2] = v;
            out[k] = v;
        }
    }
    return out;
}
