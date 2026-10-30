import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DECIDED_KEY, newNoticeId, noticeIdOf, isDecided, markDecided, unmarkDecided, once, resolvedText, decisionOf } from '../../extension/notices.mjs';
import { messageActivity } from '../../extension/activity.mjs';

test('notice ids are stable once assigned and unique per card', () => {
    const a = { name: 'Maren' }, b = { name: 'Maren' };
    const ia = noticeIdOf(a, 'remember');
    assert.equal(noticeIdOf(a, 'remember'), ia);
    assert.notEqual(noticeIdOf(b, 'remember'), ia);
    assert.match(newNoticeId('wait'), /^wait_/);
});
test('a decision is recorded once: a second Approve on the same notice is a no-op', () => {
    const msg = { extra: {} }, card = { name: 'Maren' }, nid = noticeIdOf(card, 'remember');
    let lines = 0;
    const approve = () => { if (!markDecided(msg, nid, 'approve', { swipe: 0, text: 'remember Maren' })) return; lines++; };
    approve(); approve();
    assert.equal(lines, 1);
    assert.equal(decisionOf(msg, nid).action, 'approve');
    assert.equal(markDecided(msg, nid, 'discard'), false, 'Discard after Approve is a no-op too');
});
test('two separate cards with the same wording can both be approved', () => {
    const msg = { extra: {} }, c1 = { name: 'Maren' }, c2 = { name: 'Maren' };
    assert.ok(markDecided(msg, noticeIdOf(c1, 'remember'), 'approve', { text: 'remember Maren' }));
    assert.ok(markDecided(msg, noticeIdOf(c2, 'remember'), 'approve', { text: 'remember Maren' }));
    assert.equal(Object.keys(msg.extra[DECIDED_KEY]).length, 2);
});
test('unmark takes back a failed decision', () => {
    const msg = { extra: {} }; markDecided(msg, 'x_1', 'approve'); unmarkDecided(msg, 'x_1');
    assert.equal(isDecided(msg, 'x_1'), false); assert.equal(msg.extra[DECIDED_KEY], undefined);
});
test('in-flight guard: re-entrant calls while one runs are ignored', async () => {
    let runs = 0, release;
    const gate = new Promise(r => { release = r; });
    const first = once('k', async () => { runs++; await gate; return 'done'; });
    const second = await once('k', async () => { runs++; return 'again'; });
    assert.equal(second, undefined);
    release();
    assert.equal(await first, 'done');
    assert.equal(runs, 1);
    assert.equal(await once('k', async () => 'later'), 'later', 'free again after it finishes');
});
test('resolved text and the activity log show the decision', () => {
    assert.equal(resolvedText({ action: 'approve', text: 'remembered Maren' }), '✓ Approved: remembered Maren');
    assert.equal(resolvedText({ action: 'discard' }), '✓ Discarded');
    const msg = { mes: 'x', extra: { [DECIDED_KEY]: { remember_abc: { action: 'approve', swipe: 0, text: 'remembered Maren' } } } };
    const e = messageActivity(msg, 0).find(x => x.label === 'remember notice answered');
    assert.ok(e && e.status === 'approve' && /Maren/.test(e.text), JSON.stringify(messageActivity(msg, 0)));
});
test('notices use the shared row and Approve labels (no Keep button labels left)', () => {
    const src = readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /cardButton\('Keep/);
    assert.doesNotMatch(src, /cardButton\(form \? 'Keep/);
    assert.match(src, /cardButton\('Approve', \(\) => keepRemember\(id\)/);
    assert.match(src, /markPending\(document\.createElement\('div'\)\); d\.classList\.add\('worldscrawl_remembercard'\)/);
    assert.doesNotMatch(src, /d\.append\(' ', cardButton/, 'no buttons inline at the start/middle of a notice');
});
