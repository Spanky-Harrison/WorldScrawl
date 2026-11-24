import './ststub.mjs';
import './useprompts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_RE, MOVE_RE, lookOnly, durationWords } from '../../extension/words.mjs';
const { stayPutLine, lookText } = await import('../../extension/index.js');
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
    assert.equal(t, "Everything in this reply happens in Brask's Smithy: no move happens, and the reply ends with Knarfy still there.");
    assert.doesNotMatch(t, /Do not|stays in/, 'R4 N3: what is true, not a ban list');
});

test('R5 N5: durations in words, never "45m" or "1h30m"', () => {
    const cases = [[0, 'no time at all'], [30, 'less than a minute'], [60, 'a minute'], [59, 'less than a minute'], [90, '2 minutes'], [120, '2 minutes'], [45 * 60, '45 minutes'], [3600, 'an hour'], [5400, 'an hour and a half'],
        [3600 + 15 * 60, 'an hour and 15 minutes'], [2 * 3600, '2 hours'], [9000, '2 and a half hours'], [2 * 3600 + 15 * 60, '2 hours and 15 minutes'], [8 * 3600, '8 hours'],
        [86400, 'a day'], [90000, 'a day and an hour'], [86400 + 2 * 3600 + 1800, 'a day, 2 hours and 30 minutes'], [2 * 86400, '2 days']];
    for (const [sec, want] of cases) assert.equal(durationWords(sec), want, `${sec}s`);
    for (const [sec] of cases) assert.doesNotMatch(durationWords(sec), /\b\d+[hm]\b|\d+h\d+m/);
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
    assert.deepEqual({ verb: parseBracket('[find] Old Tam').verb, target: parseBracket('[find] Old Tam').target }, { verb: 'find', target: 'Old Tam' });
    assert.equal(parseBracket('[found] Old Tam'), null, '[found] is gone');
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
    assert.ok(h.includes('/ws-help') && h.includes('/ws-go') && h.includes('/ws-open') && h.includes('/ws-bar') && h.includes('/ws-unbar') && h.includes('/ws-name') && h.includes('/ws-find'));
    assert.ok(!h.includes('/ws-found') && !h.includes('[found]'));
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

// ---- from e2e 00-setup, 02-movement, 03-names-routing (pure text functions; no browser needed)
{
const m = await import('../../extension/index.js');

test('answer parsing: think tags, prefixes, exact match; yes/no', () => {
    const p = m.parseIntentAnswer;
    assert.deepEqual([p('<think>they want to leave</think>\nOut.', ['out', 'up']), p('Answer: Elsewhere', ['out']), p('STAY', ['out']), p('the temple', ['out']), p('<think>unfinished', ['out'])],
        ['out', 'elsewhere', 'stay', null, null]);
    assert.equal(m.parseYesNo('<think>hmm</think>\nYes.'), 'yes');
    assert.equal(m.parseYesNo('maybe'), null);
});

test('answers keep a label\'s closing parenthesis', () => {
    assert.deepEqual(['"Common Room (The Drowned Rat)."', '(north)', '**Upstairs Rooms (The Gilded Goose)**', 'north)'].map(m.trimAnswer),
        ['Common Room (The Drowned Rat)', 'north', 'Upstairs Rooms (The Gilded Goose)', 'north']);
});

test('name matching: partial words, case, building tiebreak', () => {
    const c = [{ name: 'Upstairs Rooms', label: 'Upstairs Rooms (The Drowned Rat)', address: 'a' }, { name: 'Upstairs', label: 'Upstairs (The Gilded Goose)', address: 'b' }, { name: 'Common Room', label: 'Common Room (The Drowned Rat)', address: 'c' }, { name: 'Common Room', label: 'Common Room (The Gilded Goose)', address: 'd' }];
    assert.equal(m.namedInText('I flee UPSTAIRS!', c).map(x => x.address).join(), 'a,b');
    assert.equal(m.namedInText('to the common room of the drowned rat', c).map(x => x.address).join(), 'c');
    assert.equal(m.namedInText('I smile', c).length, 0);
});

test('leaving words and the way-out question', () => {
    assert.equal(m.LEAVING_RE.test('we get away from here'), true);
    assert.equal(m.LEAVING_RE.test('I go to the temple') || m.LEAVING_RE.test('the stairs on the left'), false);
    assert.equal(m.whichText([{ label: 'out (Village Square)' }, { label: 'gate (Market Lane)' }], m.WAY_OUT_PREFIX), 'Which way out? out (Village Square), gate (Market Lane)');
});

test('plural-tolerant word matching (grate/grates, stable/stables, box/boxes, kitchen/kitchens; no stem mangling)', () => {
    const grate = { direction: 'grate', description: 'A stone stair behind an iron grate.' };
    const got = [m.sameWord('grate', 'grates'), m.sameWord('Stables', 'stable'), m.sameWord('box', 'boxes'), m.sameWord('kitchen', 'Kitchens'), m.sameWord('grate', 'grat'), m.sameWord('stable', 'stabl'),
        m.sameLabel('Kitchens', 'kitchen'), m.sameLabel('The Forge', 'forge'), m.sameLabel('Stable', 'stables'), m.sameLabel('Upstairs Rooms', 'upstairs'),
        m.sameAsDirection({ direction: 'stable', to_name: 'Stable' }), m.sameAsDirection({ direction: 'kitchen', to_label: 'Kitchens' }),
        m.exitMentioned('I go through the grates', grate), m.exitMentioned('I take the stairs down', grate), m.exitMentioned('I go to the temple', grate),
        m.namedInText('go upstairs', [{ name: 'Upstairs Rooms', label: 'Upstairs Rooms', address: 'u' }]).length, m.namedInText('the common room', [{ name: 'Common Room', label: 'Common Room', address: 'c' }]).length];
    assert.deepEqual(got.map(x => typeof x === 'number' ? x : !!x), [true, true, true, true, false, false, true, true, true, false, true, true, true, true, false, 1, 1]);
});
}

const { BREAK_RE } = await import('../../extension/movement.mjs');
test('break-word check: whole words and phrases only', () => {
    assert.deepEqual(['I smash out the window', 'I eat breakfast', 'I go into the tunnel', 'there is a hole here', 'I punch through the wall', 'I make a hole in the floor', 'I kick down the door', 'the smashing pumpkins'].map(t => BREAK_RE.test(t)),
        [true, false, false, false, true, true, true, true]);
});

test('R5 round 1: a closed see-through exit names its door like every other look line; a stuck look is the stuck-door line', () => {
    assert.equal(lookText('You', 'Hall', { kind: 'threshold', via: 'north', description: 'An oak door with a grille.', through_closed: true, name: 'Yard' }),
        'What just happened: You looked through the closed north door. All that can be seen is what is right there: An oak door with a grille. It leads to Yard, but that cannot be seen from here; it may be named but do not describe what lies at the far end. You stayed at Hall.');
    for (const [via, door] of [['out', 'door out'], ['gate', 'gate']])
        assert.match(lookText('You', 'Hall', { kind: 'threshold', via, description: 'X.', through_closed: true, unknown: true }), new RegExp(`looked through the closed ${door}\\. `));
    // The same words for the closed door whichever way the look went: through a gap, at it, through it.
    for (const extra of [{ peek: true }, { shut: true }, { through_closed: true }]) {
        const t = lookText('You', 'Hall', { kind: 'threshold', via: 'north', description: 'X.', unknown: true, ...extra });
        assert.match(t, /the closed north door\. /);
        assert.doesNotMatch(t, /closed the |closed north\.|\(north\)/);
    }
    assert.equal(lookText('You', 'Hall', { kind: 'closed', via: 'north', stuck: 'is locked' }),
        'What just happened: You tried to open the north door, but it is locked. Show the north door holding fast: nothing beyond it can be seen or reached, and this reply ends with it still shut and You still at Hall.');
});
