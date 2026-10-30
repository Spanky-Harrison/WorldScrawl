// NPC phase 1: cast records, stamps, schedules, sightings, following, disposition, memory and slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the extension copy of npc.mjs matches the plugin one', () => {
    const root = new URL('../../', import.meta.url);
    const plugin = fs.readFileSync(new URL('plugin/npc.mjs', root), 'utf8');
    const copy = fs.readFileSync(new URL('extension/npc.mjs', root), 'utf8');
    assert.equal(copy.split('\n').slice(1).join('\n'), plugin);
});
import { NPC_KEY, SUGGEST_AFTER, absentAt, clampDisposition, declinesInScene, exportRecord, focusRules, followersAt, framesOf, hashRoll, hourDistance, npcSlices, parseNpcTag, presentAt, readBack, readRememberAnswer, recordDiff, resolveSchedulePlace, scheduleAt, sightChance, sightCheck, takeNpcTags, takeNpcFlags, flaggedPeople, NPC_FLAG_KEY, validateRecord } from '../../plugin/npc.mjs';
import { castNameWarnings, loadCast, writeCastNpc } from '../../plugin/cast.mjs';
import { client, copytree, RIVERTON, TAVERN, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const UP = 'riverton:drowned_rat/upstairs';
const FORGE = 'riverton:smithy/forge';
const SQUARE = 'riverton:streets/square';
const places = new Set([BAR, UP, FORGE]);
const exists = a => places.has(a);
const names = a => ({ [BAR]: 'Common Room', [UP]: 'Upstairs Rooms', [FORGE]: 'the forge' })[a] ?? a;

const hesk = (over = {}) => validateRecord({
    id: 'hesk', name: 'Hesk', line: 'The landlady.',
    disposition: { player: { value: 'indifferent', reason: 'Customers.' } },
    schedule: [
        { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00', importance: 'high' },
        { place: UP, activity: 'asleep' },
    ],
    ...over,
}, { file: 'hesk.json', places });

const msg = (text, extra = {}) => ({ mes: text, is_user: true, extra });
const npc = stamps => ({ [NPC_KEY]: stamps });
const clock = (hour, minute = 0, day = 1, elapsed = null) => ({ day, hour, minute, minutes: hour * 60 + minute, elapsed: elapsed ?? day * 86400 + hour * 3600 + minute * 60 });
const envOf = (playerAt, clockAt, relocate = {}) => ({
    exists, relocate, names: a => names(a),
    playerAt: i => (typeof playerAt === 'function' ? playerAt(i) : playerAt),
    clock: i => (typeof clockAt === 'function' ? clockAt(i) : clockAt),
});

test('a one-sentence cast record validates, and a bad file is marked instead of thrown', () => {
    const ok = validateRecord({ id: 'old-tom', name: 'Old Tom', line: 'A stooped farmer.' }, { file: 'old-tom.json' });
    assert.equal(ok.ok, true);
    assert.equal(ok.schedule.length, 0);
    const bad = validateRecord({ id: 'Nope', name: '', schedule: [{ activity: 'loitering' }, { place: 'nope/where', activity: 'gone', from: '25:00', importance: 'urgent' }] }, { file: 'other.json' });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.length >= 2);
    assert.equal(bad.schedule[0].broken, true);
    assert.equal(bad.schedule[1].broken, true);
    const dir = tmpPath();
    fs.mkdirSync(path.join(dir, 'cast'));
    fs.writeFileSync(path.join(dir, 'cast', 'hesk.json'), '{');
    fs.writeFileSync(path.join(dir, 'cast', 'old-tom.json'), JSON.stringify({ id: 'old-tom', name: 'Old Tom', line: 'A stooped farmer.' }));
    const loaded = loadCast(dir, null);
    assert.equal(loaded.npcs.length, 1);
    assert.equal(loaded.npcs[0].ok, true);
    assert.ok(loaded.problems.some(p => /hesk\.json/.test(p)));
    const missing = validateRecord({ id: 'ghost', name: 'Ghost', line: 'Nowhere.', schedule: [{ place: 'other:world/room', activity: 'waiting' }] }, { file: 'ghost.json', places });
    assert.equal(missing.ok, true, missing.problems.join('; '));
    assert.equal(missing.schedule[0].broken, true);
    assert.match(missing.schedule[0].problem, /not in this world/);
    assert.ok(missing.problems.some(p => /not in this world/.test(p)));
});

test('riverton ships Hesk, and a duplicate id is marked', () => {
    const loaded = loadCast(RIVERTON, null);
    assert.ok(loaded.npcs.some(n => n.id === 'hesk' && n.ok && n.schedule.length === 2));
    const c = client(RIVERTON);
    const body = c.get('/cast').json();
    assert.equal(body.npcs.find(n => n.id === 'hesk').name, 'Hesk');
    assert.ok(body.places.includes(BAR));
    const worlds = c.get('/worlds').json().worlds[0];
    assert.equal(worlds.cast.find(n => n.id === 'hesk').line.length > 20, true);
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    fs.writeFileSync(path.join(dir, 'cast', 'hesk-copy.json'), fs.readFileSync(path.join(dir, 'cast', 'hesk.json')));
    const dup = loadCast(dir, null);
    const copies = dup.npcs.filter(n => n.id === 'hesk');
    assert.equal(copies.length, 2);
    assert.equal(copies.filter(n => n.ok).length, 1);
    assert.ok(copies.some(n => n.problems.some(p => /duplicate/.test(p))));
});

test('schedule: evening at the bar, morning upstairs, redirects, then the next entry', () => {
    const npc0 = hesk();
    const bar = scheduleAt(npc0, clock(16, 30), { exists, relocate: {} });
    assert.equal(bar.address, BAR);
    assert.equal(bar.activity, 'pouring drinks');
    const morning = scheduleAt(npc0, clock(8), { exists, relocate: {} });
    assert.equal(morning.address, UP);
    assert.equal(morning.activity, 'asleep');
    const moved = scheduleAt(npc0, clock(18), { exists: a => a === 'riverton:drowned_rat/yard', relocate: { [BAR]: 'riverton:drowned_rat/yard' } });
    assert.equal(moved.how, 'merged');
    assert.equal(moved.address, 'riverton:drowned_rat/yard');
    const burned = { exists: a => a === UP, relocate: { [BAR]: 'riverton:nowhere' } };
    const fell = scheduleAt(npc0, clock(18), burned);
    assert.equal(fell.address, UP);
    assert.equal(scheduleAt(npc0, clock(18), { exists: () => false, relocate: { [BAR]: 'x', [UP]: 'y' } }), null);
    const miss = resolveSchedulePlace('other:world/room', { exists, relocate: {} });
    assert.equal(miss.how, 'missing');
    assert.equal(miss.ok, false);
});

test('Hesk is at the bar in the evening and does not stand in for a stranger', () => {
    const cast = [hesk()];
    const chat = [msg('A guard leans on the bar.')];
    const evening = presentAt(chat, 0, cast, envOf(BAR, clock(18)));
    assert.deepEqual(evening.map(p => p.id), ['hesk']);
    assert.match(evening[0].activity, /pouring/);
    assert.match(evening[0].line, /landlady/);
    const morning = presentAt(chat, 0, cast, envOf(BAR, clock(8)));
    assert.deepEqual(morning, []);
    const upstairs = presentAt(chat, 0, cast, envOf(UP, clock(8)));
    assert.equal(upstairs[0].id, 'hesk');
    assert.equal(upstairs[0].activity, 'asleep');
});

test('she does not vanish mid-scene; the note escalates, and a staying stamp covers one hour', () => {
    const cast = [validateRecord({
        id: 'hesk', name: 'Hesk', line: 'The landlady.',
        schedule: [
            { place: BAR, activity: 'pouring drinks', from: '16:00', to: '17:00' },
            { place: FORGE, activity: 'work', from: '17:00', to: '02:00', importance: 'high' },
        ],
    }, { file: 'hesk.json', places })];
    const chat = [msg('She is behind the bar.'), msg('Still here.')];
    const at = i => clock(i === 0 ? 16 : 18, i === 0 ? 30 : 0, 1, i === 0 ? 16 * 3600 : 18 * 3600);
    const late = presentAt(chat, 1, cast, envOf(BAR, at));
    assert.equal(late.length, 1);
    assert.equal(late[0].overdue, 'Hesk is an hour late for work (high importance).');
    const just = presentAt(chat, 1, cast, envOf(BAR, i => clock(i === 0 ? 16 : 17, i === 0 ? 0 : 10, 1, i === 0 ? 16 * 3600 : 17 * 3600 + 600)));
    assert.equal(just[0].overdue, 'Hesk is due at the forge (work, high importance).');
    chat[1].extra = npc([{ type: 'npc_staying', id: 'hesk', elapsed: 17 * 3600 }]);
    const stayed = presentAt(chat, 1, cast, envOf(BAR, i => clock(i === 0 ? 16 : 17, i === 0 ? 0 : 30, 1, i === 0 ? 16 * 3600 : 17 * 3600 + 1800)));
    assert.equal(stayed[0].overdue, '');
    chat.push(msg('She goes.', npc([{ type: 'npc_leave', id: 'hesk' }])));
    const gone = presentAt(chat, 2, cast, envOf(BAR, i => at(Math.min(i, 1))));
    assert.deepEqual(gone, []);
});

test('told to stay holds this place until the next entry, a return, or follow', () => {
    const cast = [hesk()];
    const chat = [
        msg('Come with me.', npc([{ type: 'npc_follow', id: 'hesk', who: 'player' }])),
        msg('Wait here.', npc([{ type: 'npc_stay', id: 'hesk', place: FORGE }])),
    ];
    const along = presentAt(chat, 0, cast, envOf(FORGE, clock(9)));
    assert.equal(along[0].kind, 'follow');
    assert.equal(along[0].place, FORGE);
    assert.deepEqual(followersAt(chat, 0, cast).map(f => f.id), ['hesk']);
    const held = presentAt(chat, 1, cast, envOf(FORGE, clock(9)));
    assert.equal(held[0].kind, 'stay');
    assert.equal(held[0].place, FORGE);
    assert.equal(held[0].overdue, '');
    assert.equal(followersAt(chat, 1, cast).length, 0);
    chat.push(msg('I step away.'));
    const away = presentAt(chat, 2, cast, envOf(i => (i < 2 ? FORGE : SQUARE), clock(9)));
    assert.equal(away.find(p => p.id === 'hesk'), undefined);
    const shift = [chat[0], chat[1], msg('The evening shift starts.')];
    const due = presentAt(shift, 2, cast, envOf(FORGE, i => clock(i < 2 ? 9 : 16)));
    assert.equal(due[0].id, 'hesk');
    assert.notEqual(due[0].kind, 'stay');
    assert.match(due[0].overdue, /due at/);
    const trip = [
        msg('Come.', npc([{ type: 'npc_follow', id: 'hesk' }])),
        msg('Wait.', npc([{ type: 'npc_stay', id: 'hesk', place: FORGE }])),
        msg('I leave.'),
        msg('I come back.'),
    ];
    const back = presentAt(trip, 3, cast, envOf(i => (i === 2 ? SQUARE : FORGE), clock(9)));
    assert.equal(back[0].id, 'hesk');
    assert.match(back[0].overdue, /due at/);
    trip.push(msg('Come along.', npc([{ type: 'npc_follow', id: 'hesk' }])));
    const again = presentAt(trip, 4, cast, envOf(i => (i === 2 ? SQUARE : i === 4 ? BAR : FORGE), clock(9)));
    assert.equal(again[0].kind, 'follow');
    assert.equal(again[0].place, BAR);
    assert.equal(again[0].overdue, '');
    const maren = validateRecord({ id: 'maren', name: 'Maren', line: 'A knife-grinder.', seen_at: { place: BAR, hour: 16, chance: 0.5 } }, { file: 'maren.json', places });
    const day = 3;
    const sight = [
        msg('She is here.', npc([{ type: 'npc_appear', id: 'maren', place: BAR, day, hour: 16 }, { type: 'npc_follow', id: 'maren' }])),
        msg('Wait.', npc([{ type: 'npc_stay', id: 'maren', place: FORGE }])),
        msg('The hour turns.'),
    ];
    const hour = presentAt(sight, 1, [maren], envOf(FORGE, clock(16, 30, day)));
    assert.equal(hour[0].kind, 'stay');
    assert.equal(hour[0].overdue, '');
    const later = presentAt(sight, 2, [maren], envOf(FORGE, i => clock(i < 2 ? 16 : 17, 10, day)));
    assert.equal(later[0].id, 'maren');
    assert.match(later[0].overdue, /hour here has passed/);
});

test('sightings: one roll per day, hourly falloff, a stamp for the hour, and a better by-name roll', () => {
    assert.equal(sightChance(0), 0.5);
    assert.equal(sightChance(1), 0.2);
    assert.equal(sightChance(2), 0.05);
    assert.equal(sightChance(3), 0.02);
    assert.equal(sightChance(1, 0.1), 0.1);
    assert.equal(hourDistance(16, 16), 0);
    assert.equal(hourDistance(15, 16), 1);
    assert.equal(hashRoll('same'), hashRoll('same'));
    const maren = validateRecord({ id: 'maren', name: 'Maren', line: 'A knife-grinder.', seen_at: { place: BAR, hour: 16, chance: 0.5 } }, { file: 'maren.json', places });
    let day = 0, roll = -1;
    for (; day < 400; day++) { roll = hashRoll(`sight|maren|${BAR}|${day}`); if (roll === 30) break; }
    assert.equal(roll, 30);
    const peak = sightCheck(maren, clock(16, 17, day), BAR, { exists, relocate: {} }, { useRoll: true });
    const early = sightCheck(maren, clock(15, 0, day), BAR, { exists, relocate: {} }, { useRoll: true });
    assert.equal(peak.present, true);
    assert.equal(early.present, false);
    assert.equal(early.roll, peak.roll);
    const chat = [msg('The square is busy.')];
    assert.deepEqual(presentAt(chat, 0, [maren], envOf(BAR, clock(16, 17, day))), []);
    chat[0].extra = npc([{ type: 'npc_appear', id: 'maren', place: BAR, day, hour: 16 }]);
    const here = presentAt(chat, 0, [maren], envOf(BAR, clock(16, 40, day)));
    assert.equal(here[0].id, 'maren');
    const later = presentAt([chat[0], msg('Still evening.')], 1, [maren], envOf(BAR, i => clock(i === 0 ? 16 : 19, 0, day)));
    assert.match(later[0].overdue, /hour here has passed/);
    let seekDay = -1;
    for (let d = 0; d < 800; d++) {
        const a = hashRoll(`sight|maren|${BAR}|${d}`), b = hashRoll(`seek|maren|${BAR}|${d}`);
        if (a >= 50 && b < 50) { seekDay = d; break; }
    }
    assert.ok(seekDay >= 0);
    const missed = sightCheck(maren, clock(16, 0, seekDay), BAR, { exists, relocate: {} }, { useRoll: true });
    const found = sightCheck(maren, clock(16, 0, seekDay), BAR, { exists, relocate: {} }, { useRoll: true, seeks: [{ day: seekDay }] });
    assert.equal(missed.present, false);
    assert.equal(found.present, true);
    assert.equal(found.roll, Math.min(missed.roll, hashRoll(`seek|maren|${BAR}|${seekDay}`)));
    const elsewhere = sightCheck(maren, clock(16, 0, seekDay), FORGE, { exists, relocate: {} }, { useRoll: true, seeks: [{ day: seekDay }] });
    assert.equal(elsewhere.present, false);
    const gone = validateRecord({ id: 'maren', name: 'Maren', line: 'A knife-grinder.', seen_at: { place: 'other:world/lane', hour: 16 } }, { file: 'maren.json', places });
    assert.equal(gone.seen_at.broken, true);
    assert.equal(sightCheck(gone, clock(16), BAR, { exists, relocate: {} }, { useRoll: true }).present, false);
});

test('disposition moves one step, memory stays capped, and a no lasts for the scene', () => {
    assert.equal(clampDisposition('unknown', 'hostile'), 'hostile');
    assert.equal(clampDisposition('indifferent', 'helpful'), 'friendly');
    assert.equal(clampDisposition('indifferent', 'helpful', true), 'helpful');
    assert.equal(clampDisposition('friendly', 'friendly'), 'friendly');
    const cast = [hesk()];
    const stamps = [];
    for (let i = 0; i < 9; i++) stamps.push({ type: 'npc_memory', id: 'hesk', note: `note ${i}` });
    stamps.push({ type: 'npc_disposition', id: 'hesk', who: 'player', value: 'helpful', reason: 'A rescue.' });
    const chat = [msg('talk', npc(stamps))];
    const frame = framesOf(chat, 0, cast)[0].get('hesk');
    assert.equal(frame.memory.length, 8);
    assert.equal(frame.memory[0], 'note 1');
    assert.equal(frame.disposition.player.value, 'friendly');
    const declined = [msg('no', npc([{ type: 'npc_decline', name: 'the barmaid' }])), msg('later')];
    const same = declinesInScene(declined, 1, () => BAR);
    assert.ok(same.has('the barmaid'));
    const moved = declinesInScene(declined, 1, i => (i === 0 ? BAR : UP));
    assert.equal(moved.has('the barmaid'), false);
});

test('slices, suggestions, read-back and tags', () => {
    const cast = [hesk({ manner: 'Brisk.', voice: 'Low.', deep: { history: 'Ran the river.', secrets: ['The kettle crew.'] } })];
    const chat = [msg('I ask Hesk about her past.')];
    const present = presentAt(chat, 0, cast, envOf(BAR, clock(20)));
    const focus = focusRules(chat[0].mes, present);
    assert.equal(focus.id, 'hesk');
    assert.equal(focus.depth, 'deep');
    assert.equal(focus.ambiguous, false);
    const slice = npcSlices(present, focus);
    assert.match(slice.npcs_present, /Hesk \(hesk\)/);
    assert.match(slice.npcs_present, /indifferent/);
    assert.match(slice.npcs_present, /Manner: Brisk/);
    assert.match(slice.npc_focus, /kettle crew/);
    assert.equal(focusRules('I sip my ale.', present).id, null);
    assert.equal(focusRules('I talk to her.', present).id, 'hesk');
    const fl = takeNpcFlags('Maren grins at you. [ws_flag: npc | Maren] [ws_flag: npc | Old Tom]');
    assert.deepEqual(fl.names, ['Maren', 'Old Tom']);
    assert.equal(fl.text, 'Maren grins at you.');
    const flagged = names => ({ mes: 'x', extra: { [NPC_FLAG_KEY]: [{ swipe: 0, names }] } });
    const fchat = [flagged(['Maren']), { is_user: true, mes: 'hi', extra: { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Saturday'] }] } }, flagged(['Maren', 'maren', 'Hesk']), { mes: 'Saturday header, no flag' }, flagged(['Maren', 'Tom'])];
    const fp = flaggedPeople(fchat, 0, 4, { known: ['Hesk'] });
    assert.equal(fp[0].key, 'maren'); assert.equal(fp[0].count, 3); assert.equal(fp[0].ready, true);
    assert.ok(fp.some(r => r.key === 'tom' && !r.ready));
    assert.ok(!fp.some(r => r.key === 'hesk' || r.key === 'saturday'), 'saved people and player lines are never counted');
    assert.equal(flaggedPeople(fchat, 0, 4, { declined: ['maren'] }).some(r => r.key === 'maren'), false, 'a scene no holds');
    assert.equal(flaggedPeople(fchat, 3, 4).find(r => r.key === 'maren').ready, false, 'only this scene counts');
    const messages = [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'Hello.' }, { text: 'Hi.' }, { text: 'Hey.' }, { text: 'Maren nods.' }, { text: 'Then Maren grins.' }, { text: 'I pay Maren.' }];
    const back = readBack(messages.map((m, i) => ({ ...m, index: i })), 'Maren', 2);
    assert.equal(back.start, 6);
    assert.equal(back.truncated, true);
    assert.equal(back.messages.length, 2);
    const tags = takeNpcTags('She smiles. [ws_npc: fact | hesk | a scar on her knuckle] [ws_npc: leave | hesk]');
    assert.equal(tags.stamps.length, 2);
    assert.equal(tags.stamps[0].type, 'npc_fact');
    assert.equal(tags.text, 'She smiles.');
    assert.equal(parseNpcTag('disposition | hesk | very friendly | paid the tab').value, 'friendly');
    assert.equal(parseNpcTag('disposition | hesk | devoted'), null);
    assert.deepEqual(readRememberAnswer({ name: 'Maren', personality: { summary: 'A knife-grinder.', manner: '', speech: 'Squeak.' } }), { name: 'Maren', line: 'A knife-grinder.', manner: '', voice: 'Squeak.', looks: '', body: '', outfit: '', history: '', unknownAs: '', facts: [], invented: [] });
    assert.equal(readRememberAnswer({ name: 'Maren' }), null);
});

test('keeping pulls a record, and export writes a new file instead of overwriting', () => {
    const chat = [msg('A woman introduces herself as Maren, a knife-grinder with a squeaky cart.', npc([{ type: 'npc_create', id: 'maren', name: 'Maren', line: 'A knife-grinder with a squeaky cart.' }, { type: 'npc_fact', id: 'maren', field: 'fact', text: 'Her cart squeaks.' }, { type: 'npc_follow', id: 'maren' }]))];
    const made = framesOf(chat, 0, [])[0].get('maren');
    const rec = exportRecord({ ...made, facts: made.facts, disposition: made.disposition, fromCast: [] });
    assert.equal(rec.following, undefined);
    assert.deepEqual(rec.facts, ['Her cart squeaks.']);
    const dir = tmpPath();
    copytree(RIVERTON, dir);
    const c = client(dir);
    const first = c.post('/cast/export', { json: { npc: rec } });
    assert.equal(first.status_code, 200, JSON.stringify(first.json()));
    assert.equal(first.json().id, 'maren');
    assert.equal(first.json().renamed, false);
    const second = c.post('/cast/export', { json: { npc: rec } });
    assert.equal(second.status_code, 200);
    assert.equal(second.json().renamed, true);
    assert.equal(second.json().id, 'maren-2');
    assert.ok(fs.existsSync(path.join(dir, 'cast', 'maren.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'maren.json'), 'utf8')).name, 'Maren');
    const bad = c.post('/cast/export', { json: { npc: { id: 'nope' } } });
    assert.equal(bad.status_code, 422);
    const direct = writeCastNpc(dir, { id: 'old-tom', name: 'Old Tom', personality: { summary: 'A stooped farmer.' } });
    assert.equal(direct.id, 'old-tom');
    const heskFile = JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8'));
    const played = exportRecord({ ...validateRecord(heskFile, { file: 'hesk.json' }), facts: ['a knife under the bar'] });
    const diff = recordDiff(heskFile, played);
    assert.equal(diff.changed, true);
    assert.match(diff.text, /facts/);
    assert.match(diff.text, /a knife under the bar/);
    const updated = c.post('/cast/export', { json: { npc: played, update: true } });
    assert.equal(updated.status_code, 200);
    assert.equal(updated.json().updated, true);
    assert.equal(updated.json().id, 'hesk');
    assert.equal(updated.json().renamed, false);
    assert.equal(fs.existsSync(path.join(dir, 'cast', 'hesk-2.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8')).facts, ['a knife under the bar']);
    const clash = writeCastNpc(dir, { id: 'hesk', name: 'Someone Else', personality: { summary: 'Not the landlady.' } });
    assert.equal(clash.id, 'hesk-2');
    assert.equal(clash.updated, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8')).name, 'Hesk');
});

test('absent note: Hesk off-shift in the common room is named as not here, from her schedule in force', () => {
    const cast = [hesk()];
    const chat = [msg('I sit at the bar.')];
    const morning = absentAt(chat, 0, cast, envOf(BAR, clock(8)), { present: [] });
    assert.deepEqual(morning, ["Hesk isn't here right now (asleep, Upstairs Rooms); do not portray Hesk."]);
    const evening = absentAt(chat, 0, cast, envOf(BAR, clock(18)), { present: presentAt(chat, 0, cast, envOf(BAR, clock(18))) });
    assert.deepEqual(evening, []);
    assert.deepEqual(absentAt(chat, 0, cast, envOf(FORGE, clock(8)), { present: [] }), [], 'not her place, not in the notes');
    const tom = [validateRecord({ id: 'tom', name: 'Tom', line: 'A smith.' }, { file: 'tom.json', places })];
    const named = absentAt(chat, 0, tom, envOf(FORGE, clock(8)), { lore: 'The forge is run by {{npc:tom}}.', present: [] });
    assert.deepEqual(named, ["Tom isn't here right now; do not portray Tom."], 'no schedule: no place invented');
    assert.deepEqual(absentAt(chat, 0, tom, envOf(FORGE, clock(8)), { lore: 'Tom works here.', present: [] }), [], 'a plain name is not a token: no presence line');
});

test('absent note at 08:00: a fallback entry names where; a timed-only schedule names nowhere', () => {
    const chat = [msg('I sit at the bar.')];
    assert.deepEqual(absentAt(chat, 0, [hesk()], envOf(BAR, clock(8)), { present: [] }),
        ["Hesk isn't here right now (asleep, Upstairs Rooms); do not portray Hesk."], 'Hesk: her fallback entry (asleep upstairs) is in force');
    const pell = validateRecord({ id: 'pell', name: 'Pell', line: 'The evening fiddler.', schedule: [{ place: BAR, activity: 'fiddling', from: '18:00', to: '23:00' }] }, { file: 'pell.json', places });
    assert.equal(pell.ok, true);
    assert.deepEqual(absentAt(chat, 0, [pell], envOf(BAR, clock(8)), { present: [] }),
        ["Pell isn't here right now; do not portray Pell."], 'timed entry only, out of hours: no location invented');
});

test('world load warns about plain cast names or aliases in lore/descriptions, and unknown token ids', () => {
    const world = { regions: new Map(), locations: new Map(), subregions: new Map([['riverton:drowned_rat', { name: 'The Drowned Rat', notes: 'Run by Hesk, a widow.' }]]) };
    const w = castNameWarnings(world, [hesk()]);
    assert.deepEqual(w, ['The Drowned Rat lore names cast NPC Hesk in plain text; did you mean {{npc:hesk}}?']);
    assert.deepEqual(castNameWarnings({ ...world, subregions: new Map([['x', { name: 'X', notes: 'run by {{npc:hesk}}' }]]) }, [hesk()]), [], 'a token is fine');
    const alias = { ...hesk(), raw: { aliases: ['the Widow Hesk', 'Copper'] } };
    assert.deepEqual(castNameWarnings({ ...world, subregions: new Map(), locations: new Map([['a', { name: 'Bar', description: 'Copper glares from behind the bar.' }]]) }, [alias]),
        ['Bar description names cast NPC Copper in plain text; did you mean {{npc:hesk}}?']);
    assert.deepEqual(castNameWarnings({ ...world, subregions: new Map([['x', { name: 'X', notes: 'run by {{npc:hsk}}' }]]) }, [hesk()]),
        ['X lore has {{npc:hsk}}, but no cast NPC has the id "hsk"; it shows as "hsk".']);
});

test('shipped worlds: no place notes name a cast NPC', async () => {
    const { read_world_raw, build_world } = await import('../../plugin/world.mjs');
    const root = new URL('../../worlds/riverton/', import.meta.url).pathname;
    const world = build_world(...read_world_raw(root));
    assert.deepEqual(loadCast(root, world).problems.filter(p => /cast NPC/.test(p)), []);
});

