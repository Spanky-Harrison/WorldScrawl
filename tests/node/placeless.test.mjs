// Placeless schedule entries, stub regions, and finding someone off the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NPC_KEY, FOUND_KEY, absentAt, foundEditOk, framesOf, judgeFound, nameKnown, nameStampFor, nearPhrase, offMapReport, offmapAbsentLine, presentAt, resolveNear, scheduleAt, validateRecord, withinNear } from '../../plugin/npc.mjs';
import { loadCast, saveCastNpc } from '../../plugin/cast.mjs';
import { load_world } from '../../plugin/world.mjs';
import { permanentSchedule } from '../../plugin/ui/castdata.mjs';
import { messageActivity } from '../../extension/activity.mjs';
import { client, RIVERTON, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const UP = 'riverton:drowned_rat/upstairs';
const SQUARE = 'riverton:streets/square';
const RAT = 'riverton:drowned_rat';
const rooms = new Set([BAR, UP, SQUARE, 'wickerton:green/inn']);
const stubs = new Map([['wickerton', { id: 'wickerton', name: 'Wickerton', about: "a farming town three hours' ride north of Riverton", lore: 'Grain and wool.' }]]);
const names = { [BAR]: 'Common Room', [UP]: 'Upstairs Rooms', [SQUARE]: 'Village Square', [RAT]: 'The Drowned Rat', riverton: 'Riverton' };
const index = {
    rooms, subs: new Set([RAT, 'riverton:streets']), regions: new Set(['riverton']), stubs,
    nameOf: a => names[a] ?? a, exists: a => rooms.has(a), relocate: {},
};
const env = (here, hour = 8) => ({
    exists: a => rooms.has(a), relocate: {}, names: a => names[a] ?? a, index,
    playerAt: () => here, clock: () => ({ day: 1, hour, minute: 0, minutes: hour * 60, elapsed: hour * 3600 }),
});
const msg = (text, extra = {}) => ({ mes: text, is_user: true, extra });
const hesk = (schedule) => validateRecord({
    id: 'hesk', name: 'Hesk', line: 'The landlady.',
    schedule: schedule ?? [
        { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00', importance: 'high' },
        { activity: 'asleep', where: 'her own room', near: RAT },
    ],
}, { file: 'hesk.json', places: rooms, nearIndex: index });

test('a placeless entry keeps the NPC off every room while it is in force', () => {
    const n = hesk();
    assert.equal(n.ok, true, n.problems.join('; '));
    assert.equal(n.schedule[1].place, undefined);
    assert.equal(n.schedule[1].nearNote, undefined);
    const asleep = scheduleAt(n, { minutes: 8 * 60 }, env(BAR));
    assert.equal(asleep.offmap, true);
    assert.equal(asleep.address, null);
    assert.equal(asleep.activity, 'asleep');
    assert.equal(asleep.near.kind, 'map');
    assert.equal(asleep.near.name, 'The Drowned Rat');
    for (const here of [BAR, UP, SQUARE]) assert.deepEqual(presentAt([msg('hello')], 0, [n], env(here, 8)).map(p => p.id), [], here);
    assert.deepEqual(presentAt([msg('hello')], 0, [n], env(BAR, 18)).map(p => p.id), ['hesk']);
});

test('absent lines name map, stub, and text nears, and do not place the person', () => {
    const n = hesk();
    const chat = [msg('hello')];
    const mapLine = absentAt(chat, 0, [n], env(BAR, 8));
    assert.deepEqual(mapLine, ['Hesk: asleep, somewhere off the map (her own room, in The Drowned Rat)']);
    assert.equal(absentAt(chat, 0, [n], env(SQUARE, 8)).length, 0, 'outside the near, and not named in lore, she is not mentioned');
    const john = validateRecord({
        id: 'john', name: 'John', line: 'A farmer.',
        schedule: [{ activity: 'at home', where: 'at home', near: 'wickerton' }],
    }, { file: 'john.json', places: rooms, nearIndex: index });
    const lore = '{{npc:john}} keeps a farm.';
    assert.deepEqual(absentAt(chat, 0, [john], env(BAR, 8), { lore }), [
        "John: at home, somewhere off the map (at home, in Wickerton, a farming town three hours' ride north of Riverton)",
    ]);
    const fisher = validateRecord({
        id: 'ned', name: 'Ned', line: 'A fisher.',
        schedule: [{ activity: 'fishing', near: 'a fishing camp up the river' }],
    }, { file: 'ned.json', places: rooms, nearIndex: index });
    assert.equal(fisher.schedule[0].nearNote, 'not in the list');
    assert.equal(fisher.problems.length, 0);
    assert.equal(offmapAbsentLine(fisher, scheduleAt(fisher, { minutes: 0 }, env(BAR))), 'Ned: fishing, somewhere off the map (a fishing camp up the river)');
});

test('a single unknown word is a load warning; multi-word text is only an inspector note', () => {
    const typo = validateRecord({
        id: 'ann', name: 'Ann', line: 'A clerk.',
        schedule: [{ activity: 'working', near: 'wickertonx' }],
    }, { file: 'ann.json', places: rooms, nearIndex: index });
    assert.equal(typo.ok, true);
    assert.equal(typo.schedule[0].broken, undefined);
    assert.equal(typo.schedule[0].nearNote, 'probably a typo');
    assert.ok(typo.problems.some(p => /probably a typo/.test(p) && /wickertonx/.test(p)));
    assert.match(nearPhrase(resolveNear('a fishing camp up the river', index)), /text: a fishing camp up the river \(not in the list\)/);
    assert.equal(resolveNear(RAT, index).kind, 'map');
    assert.equal(resolveNear('wickerton', index).kind, 'stub');
});

test('found is accepted only inside a map near, and the where-label stamp covers every matching entry', () => {
    const n = hesk([
        { activity: 'asleep', where: 'her own room', near: RAT, from: '02:00', to: '10:00' },
        { activity: 'reading', where: 'her own room', near: RAT, from: '10:00', to: '16:00' },
        { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00' },
    ]);
    const chat = [msg('hello')];
    assert.equal(judgeFound(n, { minutes: 18 * 60 }, BAR, env(BAR, 18)).ok, false);
    assert.match(judgeFound(n, { minutes: 8 * 60 }, SQUARE, env(SQUARE, 8)).reason, /not within/);
    const asleep = judgeFound(n, { minutes: 8 * 60 }, UP, env(UP, 8));
    assert.equal(asleep.ok, true, asleep.reason);
    assert.equal(asleep.where, 'her own room');
    const john = validateRecord({ id: 'john', name: 'John', line: 'A farmer.', schedule: [{ activity: 'at home', where: 'at home', near: 'wickerton' }] }, { file: 'john.json', places: rooms, nearIndex: index });
    assert.match(judgeFound(john, { minutes: 8 * 60 }, BAR, env(BAR)).reason, /not on the map/);
    const ned = validateRecord({ id: 'ned', name: 'Ned', line: 'A fisher.', schedule: [{ activity: 'fishing', where: 'the camp', near: 'a fishing camp up the river' }] }, { file: 'ned.json', places: rooms, nearIndex: index });
    assert.match(judgeFound(ned, { minutes: 8 * 60 }, BAR, env(BAR)).reason, /not near a mapped place/);
    const stamped = [msg('found her', { [NPC_KEY]: [{ type: 'npc_found', id: 'hesk', where: 'her own room', place: UP, source: 'flag', swipe: 0 }], [FOUND_KEY]: [{ swipe: 0, name: 'Hesk', id: 'hesk', ok: true, reason: asleep.reason, where: 'her own room', place: UP, source: 'flag' }] })];
    const morning = scheduleAt(framesOf(stamped, 0, [n])[0].get('hesk'), { minutes: 8 * 60 }, env(UP, 8));
    const midday = scheduleAt(framesOf(stamped, 0, [n])[0].get('hesk'), { minutes: 12 * 60 }, env(UP, 12));
    assert.equal(morning.how, 'found');
    assert.equal(morning.address, UP);
    assert.equal(morning.activity, 'asleep');
    assert.equal(midday.address, UP);
    assert.equal(midday.activity, 'reading');
    assert.deepEqual(presentAt(stamped, 0, [n], env(UP, 8)).map(p => p.id), ['hesk']);
    assert.deepEqual(presentAt(stamped, 0, [n], env(BAR, 8)).map(p => p.id), [], 'found in the upstairs room, not the bar');
    const undone = framesOf([msg('undo')], 0, [n])[0].get('hesk');
    assert.equal(scheduleAt(undone, { minutes: 8 * 60 }, env(UP, 8)).offmap, true);
    const off = [msg('off', { [NPC_KEY]: [{ type: 'npc_found', id: 'hesk', where: 'her own room', place: UP, off: true, swipe: 0 }] })];
    assert.equal(scheduleAt(framesOf(off, 0, [n])[0].get('hesk'), { minutes: 8 * 60 }, env(UP)).offmap, true);
    assert.equal(foundEditOk(n, 'her own room', SQUARE, env(SQUARE)).ok, false);
    assert.equal(foundEditOk(n, 'her own room', BAR, env(BAR)).place, BAR);
});

test('make permanent writes the found room into the base schedule as a placed entry', () => {
    const raw = { id: 'hesk', name: 'Hesk', personality: { summary: 'The landlady.' }, schedule: [
        { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00' },
        { activity: 'asleep', where: 'her own room', near: RAT },
        { activity: 'reading', where: 'her own room', near: RAT, from: '10:00', to: '16:00' },
    ] };
    const next = permanentSchedule(raw.schedule, 'her own room', UP);
    assert.equal(next.changed, 2);
    assert.equal(next.schedule[1].place, UP);
    assert.equal(next.schedule[1].where, undefined);
    assert.equal(next.schedule[2].place, UP);
    assert.equal(next.schedule[2].activity, 'reading');
    assert.equal(next.schedule[0].place, BAR);
    const dir = tmpPath();
    fs.mkdirSync(path.join(dir, 'cast'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cast', 'hesk.json'), JSON.stringify(raw, null, 2));
    const saved = saveCastNpc(dir, { ...raw, schedule: next.schedule }, { original: 'hesk', originalFile: 'hesk.json', places: rooms, nearIndex: index });
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'cast', saved.file), 'utf8'));
    assert.equal(disk.schedule[1].place, UP);
    assert.equal(disk.schedule[1].activity, 'asleep');
    assert.equal(disk.schedule[2].from, '10:00');
    assert.equal(disk.schedule[1].near, undefined);
});

test('a stub id resolves onto a real region with the same id, and nothing in the entry changes', () => {
    const built = { ...index, regions: new Set(['riverton', 'wickerton']), nameOf: a => (a === 'wickerton' ? 'Wickerton' : names[a] ?? a) };
    const near = resolveNear('wickerton', built);
    assert.equal(near.kind, 'map');
    assert.equal(near.scope, 'region');
    assert.equal(withinNear('wickerton:green/inn', near), true);
    assert.equal(withinNear(BAR, near), false);
    const n = validateRecord({ id: 'john', name: 'John', line: 'A farmer.', schedule: [{ activity: 'at home', where: 'at home', near: 'wickerton' }] }, { file: 'john.json', places: rooms, nearIndex: built });
    assert.equal(n.schedule[0].near, 'wickerton');
    const live = { ...env('wickerton:green/inn'), index: built, exists: a => rooms.has(a) };
    const j = judgeFound(n, { minutes: 8 * 60 }, 'wickerton:green/inn', live);
    assert.equal(j.ok, true, j.reason);
    const shadowed = load_world(RIVERTON);
    assert.equal(shadowed.elsewhere.get('wickerton').name, 'Wickerton');
    assert.equal(shadowed.regions.has('wickerton'), false);
});

test('Riverton ships Hesk asleep off the map, near the Drowned Rat, and lists Wickerton', () => {
    const w = load_world(RIVERTON);
    const cast = loadCast(RIVERTON, w);
    const heskFile = cast.npcs.find(n => n.id === 'hesk');
    assert.equal(heskFile.ok, true, cast.problems.join('; '));
    assert.equal(heskFile.schedule[1].place, undefined);
    assert.equal(heskFile.schedule[1].where, 'her own room');
    assert.equal(heskFile.schedule[1].near, RAT);
    assert.equal(cast.problems.length, 0, cast.problems.join('; '));
    const body = client(RIVERTON).get('/cast').json();
    assert.equal(body.elsewhere.find(s => s.id === 'wickerton').about, "a farming town three hours' ride north of Riverton");
    assert.equal(body.problems.length, 0, JSON.stringify(body.problems));
    const play = [{ id: 'hesk', name: 'Hesk', why: { schedule: { offmap: true, activity: 'asleep', where: 'her own room', near: { kind: 'map', scope: 'subregion', address: RAT, name: 'The Drowned Rat' } } }, foundAttempts: [{ ok: false, reason: 'not within', source: 'flag' }] }];
    const report = offMapReport(play, body.elsewhere);
    assert.equal(report.people[0].how.startsWith('map:'), true);
    assert.equal(report.stubs.find(s => s.id === 'wickerton').who.length, 0);
    assert.equal(report.found[0].ok, false);
});

test('[name] records the same per-actor name stamp as the narrator flag, and the activity log shows the bracket', () => {
    const n = validateRecord({ id: 'hesk', name: 'Hesk', unknownAs: 'the landlady', line: 'The landlady.', schedule: [{ place: BAR, activity: 'pouring drinks' }] }, { file: 'hesk.json', places: rooms });
    const made = nameStampFor([n], 'Hesk', { source: 'bracket' });
    assert.equal(made.ok, true);
    assert.deepEqual(made.stamp, { type: 'npc_name', id: 'hesk', who: 'player', source: 'bracket' });
    const chat = [msg('I [name] Hesk', { worldscrawl_bracket: { verb: 'name', target: 'Hesk', status: 'ok' }, [NPC_KEY]: [{ ...made.stamp, swipe: 0 }] })];
    assert.equal(nameKnown(framesOf(chat, 0, [n])[0].get('hesk'), chat, 0).reason, 'known: name bracket');
    const flagged = nameStampFor([n], 'Hesk', { source: 'flag' });
    assert.equal(flagged.stamp.source, 'flag');
    const act = messageActivity(chat[0], 0);
    const bracket = act.find(e => e.kind === 'bracket');
    assert.equal(bracket.label, '[name]');
    assert.match(bracket.text, /Hesk/);
    assert.equal(bracket.status, 'ok');
    const rejected = messageActivity({ extra: { worldscrawl_found: [{ name: 'Hesk', ok: false, reason: 'this room is not within it', source: 'bracket', swipe: 0 }] } }, 0);
    const flag = rejected.find(e => e.kind === 'flag' && e.label === '[found]');
    assert.equal(flag.status, 'rejected');
    assert.match(flag.text, /not within/);
});
