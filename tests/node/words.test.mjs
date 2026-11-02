import './ststub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_RE, MOVE_RE, lookOnly, stayPutLine } from '../../extension/words.mjs';
import { carrierText } from '../../plugin/ui/patchform.mjs';

// ---- from words.test.mjs
{
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
}

// ---- from bracket.test.mjs
{
// Bracket commands: "I [move] north". One verb table shared with the slash commands.



const { parseBracket, unbracket, helpText, VERBS } = await import('../../extension/index.js');

test('parseBracket: known verbs and their targets', () => {
    assert.deepEqual(parseBracket('I [move] north.'), { verb: 'move', word: 'move', target: 'north', raw: '[move] north' });
    assert.equal(parseBracket('We [go] to the Village Square, quickly').target, 'Village Square');
    assert.equal(parseBracket('[walk] through the gate').verb, 'move');
    assert.equal(parseBracket('I [look] out the window').target, 'window');
    assert.equal(parseBracket('I [look] around.').target, 'around');
    assert.equal(parseBracket('[look]').target, '');
    assert.equal(parseBracket('I [shut] the trapdoor').verb, 'close');
    assert.equal(parseBracket('[OPEN] the door').verb, 'open');
    assert.equal(parseBracket('I [break through] the east wall').verb, 'dig');
    assert.equal(parseBracket('[wait] 2h').target, '2h');
    assert.equal(parseBracket('[sleep] until morning').verb, 'sleep');
    assert.equal(parseBracket('[travel] to Riverton').verb, 'travel');
    assert.equal(parseBracket('[help]').verb, 'help');
    assert.deepEqual({ verb: parseBracket('[name] Hesk').verb, target: parseBracket('I [name] Hesk.').target }, { verb: 'name', target: 'Hesk' });
    assert.equal(parseBracket('[found] Old Tam').target, 'Old Tam');
    assert.equal(parseBracket('[move] out').target, 'out');
});
test('parseBracket: unknown bracket words are ignored', () => {
    assert.equal(parseBracket('[OOC: brb] I head north'), null);
    assert.equal(parseBracket('He said it was "teh" [sic] best'), null);
    assert.equal(parseBracket('no brackets at all'), null);
    assert.equal(parseBracket('[OOC: hi] then I [move] east').verb, 'move'); // the first known verb wins
});
test('unbracket: only known verbs lose their brackets', () => {
    assert.equal(unbracket('I [move] north [OOC: lol]'), 'I move north [OOC: lol]');
});
test('help lists every verb, with its slash command', () => {
    const h = helpText();
    for (const v of VERBS) assert.ok(h.includes(`[${v.words[0]}]`), v.id);
    assert.ok(h.includes('/ws-help') && h.includes('/ws-go') && h.includes('/ws-open') && h.includes('/ws-bar') && h.includes('/ws-unbar') && h.includes('/ws-name') && h.includes('/ws-found'));
    for (const c of ['/ws-change', '/ws-exits', '/ws-known', '/ws-reveal', '/ws-removeexit', '/ws-map', '/ws-save-world', '/ws-on']) assert.ok(h.includes(c), c);
    assert.equal(parseBracket('I [bar] the door').verb, 'bar');
    assert.equal(parseBracket('I [unbar] the cellar door').target, 'cellar door');
});
}

// ---- from carrier.test.mjs
{
test('carrier line: several changes read as a count', () => {
    assert.equal(carrierText([{ summary: ['a'] }, { summary: ['b'] }, { summary: ['c'] }]), 'Map update (3 changes)');
});
test('carrier line: one change reads as its summary', () => {
    const t = carrierText([{ summary: ['renamed hall'] }]);
    assert.match(t, /renamed hall/);
    assert.doesNotMatch(t, /changes\)/);
});
}
