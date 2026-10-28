// The map snapshot cache must give exactly what a full replay gives: after a deleted message, a swipe, and an expiry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCache, nextExpiry } from '../../plugin/snapcache.mjs';
import { read_world_raw } from '../../plugin/world.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { activeChanges } from '../../plugin/ui/patches.mjs';
import { RIVERTON, SQUARE } from './helpers.mjs';

const [WJ, RAW] = read_world_raw(RIVERTON);
const H = 3900; // spot_30 (made at 300) lasts 1h
const place = (i, { lasts, to = SQUARE } = {}) => ({ type: 'patch', id: `p${i}`, note: `p${i}`, at: i * 10, _msg: i + 1, swipe: 0,
    ops: [{ op: 'create_place', area: 'riverton:streets', id: `spot_${i}`, name: `Spot ${i}`, description: `Spot ${i}.`, ...(lasts ? { lasts } : {}),
        exits: [{ direction: `to_${i}`, to, return_direction: `spot_${i}` }] }] });
// 60 changes: some temporary, one built on a temporary room (so it fails once that runs out).
const chat = () => Array.from({ length: 60 }, (_, i) => place(i, i === 30 ? { lasts: '1h' } : i === 31 ? { to: 'riverton:streets/spot_30' } : i % 7 === 3 ? { lasts: '2h' } : {}));
const full = (changes, now) => { const info = { patches: [] }; const [wj, raw] = apply_changes(WJ, RAW, activeChanges(changes, now), { now, info, lenient: true }); return { wj, raw, info }; };
const same = (cache, changes, now, msg) => {
    const s = cache.build('riverton\u00001', WJ, RAW, changes, now), f = full(changes, now);
    assert.deepEqual(s.wj, f.wj, msg); assert.deepEqual(s.raw, f.raw, msg); assert.deepEqual(s.info, f.info, msg);
    return s;
};

test('snapshot cache: equals a full replay after a deleted message, a swipe and an expiry; replays only past the checkpoint', () => {
    const cache = new SnapshotCache();
    const ch = chat();
    const a = same(cache, ch, 0, 'cold'); assert.equal(a.from, 0);
    const b = same(cache, ch, 0, 'warm'); assert.equal(b.from, 60); assert.equal(cache.info().hits, 1);
    // Deleted message (#40): resume from the checkpoint at 25, not from scratch.
    const del = ch.filter(c => c._msg !== 41);
    const d = same(cache, del, 0, 'deleted message'); assert.equal(d.from, 25);
    // A swipe on message 50: a different patch there.
    const sw = ch.map(c => (c._msg === 50 ? { ...place(149), _msg: 50, swipe: 1 } : c));
    const s = same(cache, sw, 0, 'swipe'); assert.equal(s.from, 25);
    // The clock passes the 1h expiry: spot_30 goes, and p31 (built on it) is skipped with a note.
    assert.equal(a.expires, H);
    const e = same(cache, ch, H, 'expiry');
    assert.ok(e.info.failed.some(f => f.id === 'p31'), JSON.stringify(e.info.failed));
    // Rewind (clock back): exactly the original result again.
    same(cache, ch, 0, 'rewind');
    same(cache, ch, 2 * H, 'all temporary gone');
    // Clearing is harmless: rebuilds the same thing.
    cache.clear(); same(cache, ch, H, 'after clear');
});

test('snapshot cache: a checkpoint past its earliest expiry is not used', () => {
    const cache = new SnapshotCache({ every: 5 });
    const ch = chat().slice(0, 35);
    same(cache, ch, 0, 'warm');
    const r = same(cache, ch, H, 'expired');
    assert.equal(r.from, 30, `resumed from ${r.from}`); // the checkpoint before spot_30 is still good; later ones hold the expired room
    assert.equal(nextExpiry(ch, 0), H);
});
