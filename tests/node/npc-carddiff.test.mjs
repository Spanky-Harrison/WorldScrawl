// The NPC appearance review shows only what changes, with its own diff colors on the chat page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFields } from '../../extension/replay.mjs';
import { renderPersonDiff } from '../../plugin/ui/diffview.mjs';
import { makeDoc } from './fakedom.mjs';

const HESK_BODY = 'A tall, raw-boned woman in her late forties. Her face is weathered and freckled.';
const GNOLL_BODY = 'A tall, raw-boned gnoll in her late forties. Her muzzle is weathered and freckled.';
const OUTFIT = "Widow's black wool under a stained leather apron.";

function cand({ lastingBefore, lastingPreview, liveBefore, livePreview, sameKey = false }) {
    return { lastingBefore, lastingPreview, liveBefore, livePreview, lastingKey: 'L', liveKey: sameKey ? 'L' : 'V' };
}

test('a temporary transformation shows only Body (for now), not the unchanged lasting fields or outfit', () => {
    const base = { body: HESK_BODY, outfit: OUTFIT };
    const rows = reviewFields(cand({ lastingBefore: base, lastingPreview: base, liveBefore: base, livePreview: { body: GNOLL_BODY, outfit: OUTFIT } }));
    assert.deepEqual(rows.map(r => r.label), ['Body (for now)']);
    assert.equal(rows[0].before, HESK_BODY);
    assert.equal(rows[0].after, GNOLL_BODY);
});

test('a lasting change with no temporary layer uses plain labels', () => {
    const rows = reviewFields(cand({ sameKey: true, lastingBefore: { body: 'sturdy', outfit: 'wool' }, lastingPreview: { body: 'sturdy', outfit: 'a red cloak' }, liveBefore: { body: 'sturdy', outfit: 'wool' }, livePreview: { body: 'sturdy', outfit: 'a red cloak' } }));
    assert.deepEqual(rows.map(r => r.label), ['Outfit']);
});

test('a lasting change under an active temporary layer shows both lasting and for-now rows', () => {
    const rows = reviewFields(cand({
        lastingBefore: { body: 'sturdy', outfit: 'wool' }, lastingPreview: { body: 'scarred', outfit: 'wool' },
        liveBefore: { body: 'a gnoll', outfit: 'wool' }, livePreview: { body: 'a scarred gnoll', outfit: 'wool' },
    }));
    assert.deepEqual(rows.map(r => r.label), ['Body (lasting)', 'Body (for now)']);
});

test('an unresolved before is always shown and says so; no change at all shows nothing', () => {
    const rows = reviewFields(cand({ sameKey: true, lastingBefore: { body: '', outfit: '', unresolved: true }, lastingPreview: { body: 'sturdy', outfit: 'wool' }, liveBefore: {}, livePreview: { body: 'sturdy', outfit: 'wool' } }));
    assert.deepEqual(rows.map(r => r.label), ['Body (before unresolved)', 'Outfit (before unresolved)']);
    const same = { body: 'sturdy', outfit: 'wool' };
    assert.deepEqual(reviewFields(cand({ lastingBefore: same, lastingPreview: same, liveBefore: same, livePreview: same })), []);
});

test('the person panel marks the changed words (the one panel every card uses)', () => {
    const doc = makeDoc();
    const box = renderPersonDiff(doc, { title: 'Hesk', rows: [{ field: 'body', part: 'live', label: 'Body (for now)', before: HESK_BODY, after: GNOLL_BODY }] });
    const del = box.querySelectorAll('.wsdiff-wdel').map(n => n.textContent.trim()), ins = box.querySelectorAll('.wsdiff-wins').map(n => n.textContent.trim());
    assert.ok(del.includes('woman') && del.includes('face'), JSON.stringify(del));
    assert.ok(ins.includes('gnoll') && ins.includes('muzzle'), JSON.stringify(ins));
});
