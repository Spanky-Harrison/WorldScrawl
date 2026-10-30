// NPC appearance (phase-1 bridge): schema, when it is fed, the richer remember answer, and the cast editor round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NPC_KEY, NPC_FLAG_KEY, appearanceWhy, exportRecord, framesOf, narratorView, npcSlices, presentAt, readRememberAnswer, recordDiff, validateRecord } from '../../plugin/npc.mjs';
import { loadCast, saveCastNpc, tidyRecord } from '../../plugin/cast.mjs';
import { chatStamps, formFromPlay, formFromRecord, recordFromForm } from '../../plugin/ui/castdata.mjs';
import { copytree, RIVERTON, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const places = new Set([BAR]);
const LOOKS = 'Tall, raw-boned, copper braids.';
const rec = (over = {}) => validateRecord({ id: 'hesk', name: 'Hesk', line: 'The landlady.', appearance: LOOKS, schedule: [{ place: BAR, activity: 'pouring drinks' }], ...over }, { file: 'hesk.json', places });
const tam = validateRecord({ id: 'tam', name: 'Old Tam', line: 'A drunk.', appearance: 'Stooped, red-nosed.', schedule: [{ place: BAR, activity: 'drinking' }] }, { file: 'tam.json', places });
const env = { exists: a => places.has(a), relocate: {}, names: a => a, playerAt: () => BAR, clock: () => ({ day: 1, hour: 18, minute: 0, minutes: 1080, elapsed: 0 }) };

test('schema: appearance is optional, loads, exports, and old cards without it still load', () => {
    const r = rec();
    assert.equal(r.ok, true);
    assert.equal(r.appearance, LOOKS);
    const old = validateRecord({ id: 'old-tom', name: 'Old Tom', line: 'A farmer.' }, { file: 'old-tom.json' });
    assert.equal(old.ok, true);
    assert.equal(old.appearance, '');
    assert.equal(validateRecord({ id: 'x', name: 'X', line: 'Y.', appearance: 5 }, { file: 'x.json' }).ok, false);
    assert.equal(exportRecord({ ...r, disposition: {} }).appearance, LOOKS);
    assert.equal('appearance' in exportRecord({ ...old, disposition: {} }), false);
    assert.equal(tidyRecord({ id: 'a', name: 'A', line: 'B.', appearance: '  Short.  ' }).appearance, 'Short.');
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    const hesk = loadCast(dir, null).npcs.find(n => n.id === 'hesk');
    assert.equal(hesk.ok, true);
    assert.match(hesk.appearance, /copper braids/);
    const d = recordDiff({ ...r, appearance: '' }, r);
    assert.ok(d.lines.some(l => l.field === 'appearance' && l.to === LOOKS));
});

test('feeding: background people get only their line; a look, the focus, following, a flag or lore adds appearance with a reason', () => {
    const chat = [{ mes: 'I sit down.', is_user: true, extra: {} }];
    const present = presentAt(chat, 0, [rec(), tam], env);
    assert.deepEqual(present.map(p => p.id), ['hesk', 'tam']);
    const none = { id: null, depth: 'present' };
    assert.deepEqual(appearanceWhy(present, none, { chat, index: 0, said: 'I sit down.' }), {});
    assert.doesNotMatch(npcSlices(present, none, { appearance: {} }).npcs_present, /Appearance/);
    const look = appearanceWhy(present, { id: 'hesk', depth: 'focused' }, { chat, index: 0, said: 'I look at Hesk.' });
    assert.deepEqual(look, { hesk: 'the player looked at them' });
    const sl = npcSlices(present, { id: 'hesk', depth: 'focused' }, { appearance: look });
    assert.match(sl.npcs_present, /Hesk \(hesk\): The landlady\..*Appearance: Tall, raw-boned, copper braids\./);
    assert.doesNotMatch(sl.npcs_present, /Stooped/);
    assert.deepEqual(appearanceWhy(present, { id: 'hesk', depth: 'focused' }, { said: 'I ask Hesk for a room.' }), { hesk: 'in active interaction (in focus)' });
    assert.deepEqual(appearanceWhy(present, { id: 'hesk', depth: 'focused' }, { said: '[look] Hesk' }), { hesk: 'the player looked at them' });
    const flagged = [{ mes: 'Old Tam waves.', is_user: false, swipe_id: 0, extra: { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Old Tam'] }] } }, { mes: 'ok', is_user: true, extra: {} }];
    assert.deepEqual(appearanceWhy(present, none, { chat: flagged, index: 1 }), { tam: 'the narrator flagged them in a recent reply' });
    assert.deepEqual(appearanceWhy(present, none, { lore: 'Everyone fears {{npc:hesk}}.' }), { hesk: 'named in the lore being fed' });
    assert.deepEqual(appearanceWhy([{ ...present[1], following: { who: 'player' } }], none), { tam: 'following the player' });
    assert.deepEqual(appearanceWhy([{ ...present[0], appearance: '' }], { id: 'hesk', depth: 'focused' }, { said: 'I look at Hesk' }), {});
});

test('inspector: What the narrator was told shows whether appearance went in, and why', () => {
    const chat = [
        { mes: 'start', is_user: false, extra: {} },
        { mes: 'I look at Hesk.', is_user: true, extra: { worldscrawl_focus: { id: 'hesk', depth: 'focused', swipe: 0 } } },
        { mes: 'She glares.', is_user: false, extra: {} },
    ];
    const v = narratorView(chat, 2, [rec(), tam], env);
    assert.deepEqual(v.listed.map(x => [x.id, x.appearance]), [['hesk', 'the player looked at them'], ['tam', '']]);
    assert.match(v.npcs_present, /Appearance: Tall/);
    const w = narratorView(chat, 2, [rec(), tam], env, 'worldscrawl_focus', { loreAt: () => 'Ask {{npc:tam}}.' });
    assert.equal(w.listed.find(x => x.id === 'tam').appearance, 'named in the lore being fed');
});

test('remember: the richer answer parses, invented details are kept on the card, and a created NPC carries them', () => {
    const answer = {
        name: 'Maren', line: 'A knife-grinder who works the square.', manner: 'Brisk, watches hands.', voice: 'Squeaky, quick.',
        appearance: 'Small and wiry, with soot-dark hands. Grey eyes and a scar across her chin. A patched leather smock.',
        disposition: { value: 'friendly', reason: 'You paid without haggling.' },
        facts: ['Sharpens knives in the square'], invented: ['grey eyes', 'scar across her chin', 'squeaky voice'],
    };
    const got = readRememberAnswer(answer);
    assert.deepEqual(got, { ...answer, disposition: { value: 'friendly', reason: 'You paid without haggling.' } });
    assert.deepEqual(readRememberAnswer({ name: 'M', line: 'L.', disposition: 'Warm and kind' }).disposition, undefined);
    assert.equal(readRememberAnswer({ name: 'M', line: 'L.', disposition: 'helpful' }).disposition.value, 'helpful');
    const chat = [{ mes: 'x', is_user: false, swipe_id: 0, extra: { [NPC_KEY]: [{ type: 'npc_create', id: 'maren', name: 'Maren', line: got.line, appearance: got.appearance, invented: got.invented, swipe: 0 }] } }];
    const n = framesOf(chat, 0, [])[0].get('maren');
    assert.equal(n.appearance, got.appearance);
    assert.deepEqual(n.invented, got.invented);
    assert.equal('invented' in exportRecord(n), false); // a note for review, not canon
    const diff = recordDiff({ id: 'maren', name: 'Maren', line: got.line }, n);
    assert.match(diff.text, /Made up when remembered[\s\S]*- grey eyes/);
});

test('editor: appearance round-trips in Base mode and stamps in In-this-chat mode', () => {
    const r = { id: 'hesk', name: 'Hesk', line: 'The landlady.', appearance: LOOKS };
    const f = formFromRecord(r);
    assert.equal(f.appearance, LOOKS);
    assert.deepEqual(recordFromForm(f), r);
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    saveCastNpc(dir, { ...recordFromForm(f), appearance: 'New look.' }, { original: 'hesk' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8')).appearance, 'New look.');
    const play = { id: 'hesk', name: 'Hesk', line: 'The landlady.', appearance: LOOKS, disposition: {}, facts: [], memory: [], deep: {} };
    const g = formFromPlay(play);
    assert.equal(g.appearance, LOOKS);
    g.appearance = 'Changed.';
    assert.deepEqual(chatStamps(play, g).stamps, [{ type: 'npc_fact', field: 'appearance', text: 'Changed.' }]);
    const chat = [{ mes: 'x', is_user: false, swipe_id: 0, extra: { [NPC_KEY]: [{ type: 'npc_fact', id: 'hesk', field: 'appearance', text: 'Changed.', swipe: 0 }] } }];
    assert.equal(framesOf(chat, 0, [rec()])[0].get('hesk').appearance, 'Changed.');
});
