// Bracket commands: "I [move] north". One verb table shared with the slash commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
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
    assert.ok(h.includes('/ws-help') && h.includes('/ws-go') && h.includes('/ws-open') && h.includes('/ws-bar') && h.includes('/ws-unbar'));
    for (const c of ['/ws-change', '/ws-exits', '/ws-known', '/ws-reveal', '/ws-removeexit', '/ws-map', '/ws-save-world', '/ws-on']) assert.ok(h.includes(c), c);
    assert.equal(parseBracket('I [bar] the door').verb, 'bar');
    assert.equal(parseBracket('I [unbar] the cellar door').target, 'cellar door');
});
