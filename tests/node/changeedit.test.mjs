// The change editor tab: URL session, touched-place tabs, and the ST-side checks before a stamp is rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
import { sessionFromUrl, touchedTargets, combineOps, targetOf } from '../../plugin/ui/changeedit.mjs';
const X = await import('../../extension/index.js');

test('sessionFromUrl: only edit=1 with chat, msg and change', () => {
    assert.deepEqual(sessionFromUrl('?edit=1&chat=c1&msg=4&swipe=0&change=p1&hash=abc'), { chat: 'c1', msg: '4', swipe: '0', change: 'p1', hash: 'abc' });
    assert.equal(sessionFromUrl('?chat=c1&msg=4&change=p1'), null);
    assert.equal(sessionFromUrl('?edit=1&msg=4'), null);
});
test('touchedTargets: rooms first, then areas as sub:/region:, each once', () => {
    assert.deepEqual(touchedTargets(['r:a', 'r:a/x', 'r', 'r:a/x', 'r:a/y']), ['r:a/x', 'r:a/y', 'sub:r:a', 'region:r']);
    assert.equal(targetOf('r:a/x'), 'r:a/x');
    assert.deepEqual(combineOps([{ op: 'a' }], [[{ op: 'b' }], [], [{ op: 'c' }]]).map(o => o.op), ['a', 'b', 'c']);
});
test('changeEditUrl / changeEditMismatch: chat, message, swipe and change must all still match', () => {
    const p = { id: 'p1', ops: [{ op: 'set_description', target: 'r:a/x', text: 'Burnt.' }] };
    const chat = [{ mes: 'hi' }, { mes: 'reply', swipe_id: 1, extra: { worldscrawl_patches: [{ ...p, swipe: 1 }] } }];
    const url = X.changeEditUrl(1, p, chat, 'chat-A');
    assert.match(url, /\/ui\/\?edit=1&chat=chat-A&msg=1&swipe=1&change=p1&hash=/);
    const d = sessionFromUrl(url.slice(url.indexOf('?')));
    assert.equal(X.changeEditMismatch(d, chat, 'chat-A'), '');
    assert.match(X.changeEditMismatch(d, chat, 'chat-B'), /not the one open/);
    assert.match(X.changeEditMismatch({ ...d, msg: '5' }, chat, 'chat-A'), /no longer in the chat/);
    assert.match(X.changeEditMismatch(d, [chat[0], { ...chat[1], swipe_id: 0 }], 'chat-A'), /different swipe/);
    assert.match(X.changeEditMismatch({ ...d, change: 'p2' }, chat, 'chat-A'), /no longer on its message/);
    const edited = [chat[0], { ...chat[1], extra: { worldscrawl_patches: [{ ...p, swipe: 1, ops: [{ op: 'set_description', target: 'r:a/x', text: 'Rebuilt.' }] }] } }];
    assert.match(X.changeEditMismatch(d, edited, 'chat-A'), /edited since/);
});
