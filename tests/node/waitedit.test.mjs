// Re-timing a kept wait moves the clock, so expiries it now crosses (or no longer reaches) are rechecked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
import { activeChanges, expiredBetween } from '../../plugin/ui/patches.mjs';
const { waitExpiryDelta, editKeptWait } = await import('../../extension/index.js');
const H = 3600;

test('editing an already-kept wait rechecks the expiries it now crosses or no longer crosses', () => {
    const fire = { type: 'patch', id: 'p1', at: 0, summary: ['smoke over the inn'], ops: [{ op: 'set_description', target: 'a', description: 'smoke', lasts: '12h' }] };
    const flood = { type: 'patch', id: 'p2', at: 0, summary: ['the cellar is flooded'], ops: [{ op: 'set_description', target: 'b', description: 'wet', lasts: '5h' }] };
    const ch = [fire, flood];
    // kept as 2h from 2h in (nothing ran out); re-timed to 12h: both now run out
    let d = waitExpiryDelta(ch, 2 * H, 2 * H, 12 * H, expiredBetween);
    assert.deepEqual(d.crossed.map(g => g.note).sort(), ['smoke over the inn', 'the cellar is flooded']); assert.deepEqual(d.uncrossed, []);
    // kept as 12h; shortened to 2h: neither runs out any more
    d = waitExpiryDelta(ch, 2 * H, 12 * H, 2 * H, expiredBetween);
    assert.deepEqual(d.crossed, []); assert.deepEqual(d.uncrossed.map(g => g.note).sort(), ['smoke over the inn', 'the cellar is flooded']);
    // 2h -> 4h: only the flood is newly crossed; same length: nothing changes
    d = waitExpiryDelta(ch, 2 * H, 2 * H, 4 * H, expiredBetween);
    assert.deepEqual(d.crossed.map(g => g.note), ['the cellar is flooded']);
    assert.deepEqual(waitExpiryDelta(ch, 2 * H, 4 * H, 4 * H, expiredBetween), { crossed: [], uncrossed: [] });
    // and the map follows the clock: active at the new time
    assert.equal(activeChanges(ch, 14 * H).reduce((n, c) => n + c.ops.length, 0), 0);
    assert.equal(activeChanges(ch, 6 * H).reduce((n, c) => n + c.ops.length, 0), 1);
});

test('editKeptWait refuses a message with no kept wait', async () => {
    globalThis.SillyTavern.getContext().chat = [{ extra: {} }];
    assert.match((await editKeptWait(0, '2h')).error, /no kept wait/);
});
