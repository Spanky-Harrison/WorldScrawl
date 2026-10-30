// The NPC card: schema (personality / appearance / history / unknownAs), feeding tiers, name knowledge, the richer
// remember answer, and the cast editor round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NPC_KEY, NPC_FLAG_KEY, exportRecord, framesOf, nameKnown, narratorView, npcForName, npcSlices, npcTiers, presentAt, readRememberAnswer, recordDiff, takeNameFlags, validateRecord } from '../../plugin/npc.mjs';
import { loadCast, saveCastNpc, tidyRecord } from '../../plugin/cast.mjs';
import { chatStamps, formFromPlay, formFromRecord, recordFromForm } from '../../plugin/ui/castdata.mjs';
import { copytree, RIVERTON, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const places = new Set([BAR]);
const CARD = {
    id: 'hesk', name: 'Hesk', unknownAs: 'the landlady',
    personality: { summary: 'stern, watchful', manner: 'Brisk.', speech: 'Low and flat.' },
    appearance: { summary: 'big woman, copper braids', body: 'Tall, raw-boned.', outfit: 'Widow\'s black, leather apron.' },
    history: 'Widowed young; runs the inn alone.',
    schedule: [{ place: BAR, activity: 'pouring drinks' }],
};
const rec = (over = {}) => validateRecord({ ...CARD, ...over }, { file: 'hesk.json', places });
const tam = validateRecord({ id: 'tam', name: 'Old Tam', personality: { summary: 'a drunk' }, appearance: { summary: 'red-nosed', body: 'Stooped.' }, schedule: [{ place: BAR, activity: 'drinking' }] }, { file: 'tam.json', places });
const env = { exists: a => places.has(a), relocate: {}, names: a => a, playerAt: () => BAR, clock: () => ({ day: 1, hour: 18, minute: 0, minutes: 1080, elapsed: 0 }) };
const user = (mes, extra = {}) => ({ mes, is_user: true, extra });
const bot = (mes, extra = {}) => ({ mes, is_user: false, swipe_id: 0, extra });

test('schema: nested personality / appearance, history, unknownAs load, tidy and export; summary is required', () => {
    const r = rec();
    assert.equal(r.ok, true);
    assert.deepEqual([r.line, r.manner, r.voice, r.looks, r.body, r.outfit, r.unknownAs, r.deep.history],
        ['stern, watchful', 'Brisk.', 'Low and flat.', 'big woman, copper braids', 'Tall, raw-boned.', 'Widow\'s black, leather apron.', 'the landlady', 'Widowed young; runs the inn alone.']);
    assert.equal(validateRecord({ id: 'x', name: 'X' }, { file: 'x.json' }).ok, false);
    assert.equal(validateRecord({ id: 'x', name: 'X', personality: { summary: 'y' }, appearance: 5 }, { file: 'x.json' }).ok, false);
    const out = exportRecord({ ...r, disposition: {} });
    for (const k of ['id', 'name', 'unknownAs', 'personality', 'appearance', 'history']) assert.deepEqual(out[k], CARD[k], k);
    assert.equal(out.deep?.history, undefined);
    assert.deepEqual(tidyRecord({ ...CARD, personality: { summary: ' s ', manner: '' }, appearance: { body: '' } }).personality, { summary: 's' });
    assert.equal('appearance' in tidyRecord({ ...CARD, appearance: { body: '' } }), false);
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    const hesk = loadCast(dir, null).npcs.find(n => n.id === 'hesk');
    assert.equal(hesk.ok, true);
    assert.equal(hesk.unknownAs, 'the landlady');
    assert.match(hesk.looks, /copper braids/);
    assert.match(hesk.outfit, /apron/);
    assert.match(hesk.deep.history, /Drowned Rat/);
    const d = recordDiff({ ...CARD, appearance: { summary: 'x' } }, out);
    assert.ok(d.lines.some(l => l.field === 'appearance.body'));
});

test('tiers: present people get summary lines; a look, focus, following or a flag makes them engaged; lore adds history', () => {
    const chat = [user('I sit down.')];
    const present = presentAt(chat, 0, [rec(), tam], env);
    const none = { id: null, depth: 'present' };
    const bg = npcTiers(present, none, { chat, index: 0, said: 'I sit down.' });
    assert.deepEqual(Object.values(bg).map(t => t.tier), ['present', 'present']);
    const s0 = npcSlices(present, none, { tiers: bg }).npcs_present;
    assert.match(s0, /Looks: big woman, copper braids\. Demeanor: stern, watchful/);
    assert.doesNotMatch(s0, /Body|Wearing|Manner|Speech|History|Stooped/);
    const look = npcTiers(present, { id: 'hesk', depth: 'focused' }, { said: 'I look at Hesk.' });
    assert.deepEqual([look.hesk.tier, look.hesk.why, look.tam.tier], ['engaged', 'the player looked at them', 'present']);
    const s1 = npcSlices(present, { id: 'hesk', depth: 'focused' }, { tiers: look }).npcs_present;
    assert.match(s1, /Body: Tall, raw-boned\..*Wearing: Widow's black.*Manner: Brisk\..*Speech: Low and flat\./);
    assert.doesNotMatch(s1, /History/);
    assert.equal(npcTiers(present, { id: 'hesk', depth: 'focused' }, { said: 'I ask for a room.' }).hesk.why, 'in active interaction (in focus)');
    assert.equal(npcTiers([{ ...present[1], following: { who: 'player' } }], none).tam.why, 'following the player');
    const flagged = [bot('Old Tam waves.', { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Old Tam'] }] }), user('ok')];
    assert.equal(npcTiers(present, none, { chat: flagged, index: 1 }).tam.tier, 'engaged');
    const topical = npcTiers(present, none, { asked: ['Hesk'] });
    assert.deepEqual([topical.hesk.tier, topical.hesk.topical], ['present', true]);
    assert.match(npcSlices(present, none, { tiers: topical }).npcs_present, /History: Widowed young/);
    assert.equal(npcTiers(present, none, { asked: ['the landlady'] }).hesk.topical, true);
    assert.equal(npcTiers(present, none, { asked: ['Old Tam'] }).tam.topical, false, 'no history on the card, nothing to add');
});

test('name knowledge: per actor, from stamps and flags only, never from chat text', () => {
    const chat = [user('Her name is Hesk, says the drunk.')];
    const [h] = presentAt(chat, 0, [rec()], env);
    assert.deepEqual(h.known, { known: false, reason: 'not known: shown as "the landlady"' });
    const s = npcSlices([h], {}).npcs_present;
    assert.match(s, /^the landlady \[hesk\] \(the player does not know this person's name yet; it is Hesk\..*\[ws_flag: name \| Hesk\]\)/);
    assert.equal(nameKnown(tam, [], 0).reason, 'known: no unknownAs on the card');
    const flaggedChat = [bot('Hesk glares.', { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Hesk'] }] })];
    assert.deepEqual(nameKnown(rec(), flaggedChat, 0), { known: true, reason: 'known: flagged' });
    assert.equal(nameKnown(rec(), flaggedChat, 0, 'tam').known, false, 'a flag is the player\'s, not everyone\'s');
    const named = [bot('"I\'m Hesk," she says.', { [NPC_KEY]: [{ type: 'npc_name', id: 'hesk', who: 'player', source: 'flag', swipe: 0 }] })];
    const folded = framesOf(named, 0, [rec()])[0].get('hesk');
    assert.deepEqual(nameKnown(folded, named, 0), { known: true, reason: 'known: name flag' });
    assert.equal(nameKnown(folded, named, 0, 'tam').known, false);
    const made = framesOf([bot('x', { [NPC_KEY]: [{ type: 'npc_create', id: 'maren', name: 'Maren', line: 'a grinder', unknownAs: 'the grinder', swipe: 0 }] })], 0, [])[0].get('maren');
    assert.equal(nameKnown(made, [], 0).reason, 'known: remembered');
    const t = takeNameFlags('She nods. [ws_flag: name | Hesk]');
    assert.deepEqual(t, { names: ['Hesk'], text: 'She nods.' });
    assert.equal(npcForName([rec(), tam], 'hesk').id, 'hesk');
    assert.equal(npcForName([rec(), tam], 'Tam').id, 'tam');
    assert.equal(npcForName([rec(), tam], 'Nobody'), null);
});

test('inspector: each listed person shows tier, reason and name state', () => {
    const chat = [bot('start'), user('I look at the landlady.', { worldscrawl_focus: { id: 'hesk', depth: 'focused', swipe: 0 } }), bot('She glares.')];
    const v = narratorView(chat, 2, [rec(), tam], env);
    const h = v.listed.find(x => x.id === 'hesk'), t = v.listed.find(x => x.id === 'tam');
    assert.deepEqual([h.tier, h.why, h.known, h.nameWhy, h.shownAs], ['engaged', 'the player looked at them', false, 'not known: shown as "the landlady"', 'the landlady']);
    assert.deepEqual([t.tier, t.known, t.nameWhy], ['present', true, 'known: no unknownAs on the card']);
});

test('remember: every field parses, invented details stay on the card and out of the file', () => {
    const answer = {
        name: 'Maren', unknownAs: 'the knife-grinder',
        personality: { summary: 'cheerful, shrewd', manner: 'Watches hands.', speech: 'Squeaky, quick.' },
        appearance: { summary: 'wiry woman with a grinding cart', body: 'Small and wiry, grey eyes, a scar on the chin.', outfit: 'A patched leather smock.' },
        history: 'Came up the river as a girl.', disposition: { value: 'friendly', reason: 'You paid without haggling.' },
        facts: ['Sharpens knives in the square'], invented: ['grey eyes', 'scar on the chin'],
    };
    const got = readRememberAnswer(answer);
    assert.deepEqual(got, { name: 'Maren', line: 'cheerful, shrewd', manner: 'Watches hands.', voice: 'Squeaky, quick.', looks: 'wiry woman with a grinding cart',
        body: 'Small and wiry, grey eyes, a scar on the chin.', outfit: 'A patched leather smock.', history: 'Came up the river as a girl.', unknownAs: 'the knife-grinder',
        facts: ['Sharpens knives in the square'], invented: ['grey eyes', 'scar on the chin'], disposition: { value: 'friendly', reason: 'You paid without haggling.' } });
    assert.equal(readRememberAnswer({ name: 'M', line: 'old shape' }), null);
    assert.equal(readRememberAnswer({ name: 'M', personality: { summary: 'L' }, disposition: 'Warm and kind' }).disposition, undefined);
    const { name, line, manner, voice, looks, body, outfit, history, unknownAs, invented } = got;
    const chat = [bot('x', { [NPC_KEY]: [{ type: 'npc_create', id: 'maren', name, line, manner, voice, looks, body, outfit, history, unknownAs, invented, swipe: 0 }] })];
    const n = framesOf(chat, 0, [])[0].get('maren');
    assert.deepEqual([n.looks, n.body, n.outfit, n.deep.history, n.unknownAs], [looks, body, outfit, history, unknownAs]);
    const out = exportRecord(n);
    assert.equal('invented' in out, false);
    assert.deepEqual(out.personality, answer.personality);
    assert.deepEqual(out.appearance, answer.appearance);
    assert.equal(out.history, answer.history);
    const diff = recordDiff({ id: 'maren', name: 'Maren', personality: { summary: line } }, n);
    assert.match(diff.text, /Made up when remembered[\s\S]*- grey eyes/);
});

test('editor: every card field round-trips in Base mode and stamps in In-this-chat mode', () => {
    const r = { id: 'hesk', name: 'Hesk', unknownAs: CARD.unknownAs, personality: CARD.personality, appearance: CARD.appearance, history: CARD.history };
    const f = formFromRecord(r);
    assert.deepEqual([f.line, f.voice, f.looks, f.body, f.outfit, f.history, f.unknownAs], ['stern, watchful', 'Low and flat.', 'big woman, copper braids', 'Tall, raw-boned.', 'Widow\'s black, leather apron.', CARD.history, 'the landlady']);
    assert.deepEqual(recordFromForm(f), r);
    assert.deepEqual(formFromRecord(rec()).outfit, f.outfit, 'a loaded record fills the form too');
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    saveCastNpc(dir, recordFromForm({ ...formFromRecord(loadCast(dir, null).npcs.find(n => n.id === 'hesk')), outfit: 'New coat.' }), { original: 'hesk' });
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8'));
    assert.equal(disk.appearance.outfit, 'New coat.');
    assert.equal(disk.unknownAs, 'the landlady');
    assert.match(disk.history, /Drowned Rat/);
    const play = { ...rec(), disposition: {}, facts: [], memory: [] };
    const g = formFromPlay(play);
    g.outfit = 'Changed.'; g.unknownAs = 'the widow'; g.history = 'New past.';
    assert.deepEqual(chatStamps(play, g).stamps, [
        { type: 'npc_fact', field: 'appearance.outfit', text: 'Changed.' },
        { type: 'npc_fact', field: 'history', text: 'New past.' },
        { type: 'npc_fact', field: 'unknownAs', text: 'the widow' },
    ]);
    const chat = [bot('x', { [NPC_KEY]: chatStamps(play, g).stamps.map(s => ({ ...s, id: 'hesk', swipe: 0 })) })];
    const n = framesOf(chat, 0, [rec()])[0].get('hesk');
    assert.deepEqual([n.outfit, n.unknownAs, n.deep.history], ['Changed.', 'the widow', 'New past.']);
});
