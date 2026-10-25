import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_RE, MOVE_RE, lookOnly, stayPutLine } from '../../extension/words.mjs';

test('look-only messages: a perception word and no movement word', () => {
    for (const t of ['I look out the door', 'I peer out the window', 'I glance up the stairs', 'I listen at the back door', 'I gaze north', 'I watch the street from the doorway', 'I peek out', 'I look around'])
        assert.equal(lookOnly(t), true, t);
    for (const t of ['I go out', 'I step out to look around', 'I head north', 'I leave and look back', 'I look out, then walk out the door', 'I climb up to peer at the roof', 'I run outside', 'I enter the shop', 'I open the door'])
        assert.equal(lookOnly(t), false, t);
    assert.ok(LOOK_RE.test('She stares at him') && !LOOK_RE.test('I outlook nothing'));
    assert.ok(MOVE_RE.test('we went in') && !MOVE_RE.test('a goal'));
});

test('stay-put line: still in the room, not leaving or arriving', () => {
    const t = stayPutLine('Knarfy', "Brask's Smithy");
    assert.match(t, /has NOT moved this turn and is still at Brask's Smithy/);
    assert.match(t, /do not describe Knarfy leaving, stepping out, going through any exit or arriving anywhere else/);
    assert.match(t, /Everything this turn happens in Brask's Smithy\./);
});
