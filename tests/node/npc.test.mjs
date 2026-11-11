import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportRecord, resolveSchedulePlace } from '../../plugin/shared/npc.mjs';
import { validateRecord } from '../../plugin/npc.mjs';
import { NPC_KEY, SUGGEST_AFTER, absentAt, clampDisposition, claimResult, claimWarnings, declinesInScene, focusRules, followersAt, framesOf, hashRoll, hourDistance, npcSlices, parseNpcTag, presentAt, readBack, readRememberAnswer, recordDiff, scheduleAt, sightChance, sightCheck, takeNpcTags, takeNpcFlags, flaggedPeople, NPC_FLAG_KEY, nameKnown, narratorView, npcForName, npcTiers, takeNameFlags, foundEditOk, judgeFound, loreScope, takeLoreFlags, loreFor, addLoreRequest, loreRequests, activeLore, renderNpcTokens } from '../../extension/npc.mjs';
import { castNameWarnings, loadCast, writeCastNpc, saveCastNpc, tidyRecord } from '../../plugin/cast.mjs';
import { client, copytree, RIVERTON, TAVERN, tmpPath, makeWorld } from './helpers.mjs';
import { chatStamps, formFromPlay, formFromRecord, recordFromForm, liveSchedule, permanentProblem, CHAT_ONLY_ROOM } from '../../plugin/ui/castdata.mjs';
import { load_world } from '../../plugin/world.mjs';

// ---- from npc.test.mjs
{
// NPC phase 1: cast records, stamps, schedules, sightings, following, disposition, memory and slices.





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
    assert.equal(bad.schedule[0].broken, undefined, 'no place and an activity is a placeless entry, not a broken one');
    assert.equal(bad.schedule[0].activity, 'loitering');
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
    assert.match(slice.npcs_present, /^Hesk \[p[0-9a-z]+\]:/, 'the shown name and an opaque handle, never the cast id');
    assert.doesNotMatch(slice.npcs_present, /\bhesk\b/);
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
}

// ---- from npccard.test.mjs
{
// The NPC card: schema (personality / appearance / history / unknownAs), feeding tiers, name knowledge, the richer
// remember answer, and the cast editor round trip.









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

test('name knowledge: per actor, from stamps only, never from chat text', () => {
    const chat = [user('Her name is Hesk, says the drunk.')];
    const [h] = presentAt(chat, 0, [rec()], env);
    assert.deepEqual(h.known, { known: false, reason: 'not known: shown as "the landlady"' });
    const s = npcSlices([h], {}).npcs_present;
    assert.match(s, /^the landlady \[p[0-9a-z]+\]:/);
    assert.doesNotMatch(s, /Hesk|\bhesk\b/, 'no gate given: the name is nowhere');
    const gated = npcSlices([h], {}, { gate: p => `GATE(${p.id})` }).npcs_present;
    assert.match(gated, /^the landlady \[p[0-9a-z]+\]: GATE\(hesk\)/, 'the gated line follows an unknown person');
    assert.doesNotMatch(s, /ws_flag/);
    assert.equal(nameKnown(tam, [], 0).reason, 'known: no unknownAs on the card');
    const flaggedChat = [bot('Hesk glares.', { [NPC_FLAG_KEY]: [{ swipe: 0, names: ['Hesk'] }] })];
    const flagged = framesOf(flaggedChat, 0, [rec()])[0].get('hesk');
    assert.equal(nameKnown(flagged, flaggedChat, 0).known, false, 'an npc flag means met, not named (#95 name tools name them)');
    assert.equal(flagged.rel.player.state, 'met');
    assert.equal(nameKnown(flagged, flaggedChat, 0, 'tam').known, false, 'a flag is the player\'s, not everyone\'s');
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
        { type: 'npc_baseline', field: 'outfit', text: 'Changed.' },
        { type: 'npc_fact', field: 'history', text: 'New past.' },
        { type: 'npc_fact', field: 'unknownAs', text: 'the widow' },
    ]);
    const approved = { type: 'npc_baseline', id: 'hesk', owner: 'o_outfit', swipe: 0, start: 0, lasts: null, contentId: 'c_outfit', candidate: null, identity: { owner: 'o_outfit', message: 'm', swipe: 0, npc: 'hesk', domain: 'baseline', chat: 'c' }, committed: { kind: 'baseline', field: 'outfit', text: 'Changed.' } };
    const chat = [bot('x', { [NPC_KEY]: [approved, { type: 'npc_fact', id: 'hesk', field: 'history', text: 'New past.', swipe: 0 }, { type: 'npc_fact', id: 'hesk', field: 'unknownAs', text: 'the widow', swipe: 0 }] })];
    const n = framesOf(chat, 0, [rec()])[0].get('hesk');
    assert.deepEqual([n.outfit, n.unknownAs, n.deep.history], ['Changed.', 'the widow', 'New past.']);
});
}

// ---- from liveschedule.test.mjs
{
// The Cast summary's schedule is live: card entries with this chat's changes folded in, the entry in force marked.




const BAR = 'riverton:drowned_rat/common_room', UP = 'riverton:drowned_rat/upstairs';
const card = { schedule: [
    { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00' },
    { activity: 'asleep', where: 'her own room', near: 'riverton:drowned_rat', from: '02:00', to: '10:00' },
] };

test('no play: the card as is', () => {
    const rows = liveSchedule(card, null);
    assert.deepEqual(rows.map(r => r.src), ['card', 'card']);
    assert.equal(rows[1].place, '');
});

test('found placement fills the where-label, marked as this chat, and the current entry is flagged', () => {
    const play = { record: card, stamps: [{ type: 'npc_found', where: 'her own room', place: UP, msg: 3 }],
        why: { schedule: { activity: 'asleep', where: 'her own room', address: UP } } };
    const rows = liveSchedule(card, play);
    assert.equal(rows[1].place, UP);
    assert.equal(rows[1].src, 'chat');
    assert.deepEqual(rows[1].notes, ['found here this chat']);
    assert.equal(rows[1].current, true);
    assert.equal(rows[0].current, false);
    assert.equal(rows[0].src, 'card');
});

test('turned-off found stamps are ignored; chat edits and follow/stay overrides show', () => {
    const edited = { schedule: [{ ...card.schedule[0], activity: 'mopping the floor' }, card.schedule[1]] };
    const rows = liveSchedule(card, { record: edited, stamps: [{ type: 'npc_found', where: 'her own room', place: UP, off: true }], held: { place: BAR }, why: { held: { active: true }, schedule: { activity: 'mopping the floor', where: '', address: BAR } } });
    assert.equal(rows[0].activity, 'staying here');
    assert.equal(rows[0].current, true);
    assert.equal(rows[1].src, 'chat');
    assert.deepEqual(rows[1].notes, ['changed in this chat']);
    assert.equal(rows[1].current, false, 'the stay overrides the schedule');
    assert.equal(rows[2].place, '');
    const f = liveSchedule(card, { record: card, stamps: [], following: { who: 'player' }, why: {} });
    assert.match(f[0].activity, /following you/);
});
}

// ---- from liveplaces.test.mjs
{
// Rooms made by this chat's map changes count for every NPC-side check (one live-map lookup), and a chat-only room
// is never written into a base schedule.






const RAT = 'riverton:drowned_rat', BAR = `${RAT}/common_room`, UP = `${RAT}/upstairs`, NEW = `${RAT}/hesks_room`;
const changes = [{ type: 'patch', id: 'p1', ops: [{ op: 'create_place', area: RAT, name: "Hesk's Room", description: 'A small room.', exits: [{ to: UP, direction: 'out', return_direction: 'hesk' }] }] }];

function envFrom(places, here) {
    const rooms = new Set(places.places);
    const index = { rooms, subs: new Set(places.subs), regions: new Set(places.regions), stubs: new Map(), nameOf: a => places.place_labels[a] ?? a, exists: a => rooms.has(a), relocate: {} };
    return { exists: a => rooms.has(a), relocate: {}, names: a => places.place_labels[a] ?? a, index, playerAt: () => here, clock: () => ({ day: 1, hour: 8, minute: 0, minutes: 480, elapsed: 0 }) };
}

test('live places include a room discovered in this chat; found, presence and the found edit accept it', () => {
    const c = client(RIVERTON);
    const base = c.get('/cast').json(), live = c.post('/cast/places', { json: { changes, now: 0 } }).json();
    assert.equal(base.places.includes(NEW), false);
    assert.equal(live.places.includes(NEW), true);
    assert.equal(live.place_labels[NEW], "Hesk's Room");
    const env = envFrom(live, NEW), baseEnv = envFrom(base, NEW);
    const n = validateRecord({ id: 'hesk', name: 'Hesk', line: 'The landlady.', schedule: [{ activity: 'resting', where: 'her own room', near: RAT }] }, { file: 'hesk.json', places: new Set(live.places), nearIndex: env.index });
    const j = judgeFound(n, { minutes: 480 }, NEW, env);
    assert.equal(j.ok, true, j.reason);
    const chat = [{ mes: 'found', is_user: true, extra: { [NPC_KEY]: [{ type: 'npc_found', id: 'hesk', where: 'her own room', place: NEW, source: 'bracket', swipe: 0 }] } }];
    assert.deepEqual(presentAt(chat, 0, [n], env).map(p => p.id), ['hesk']);
    assert.deepEqual(presentAt(chat, 0, [n], baseEnv).map(p => p.id), [], 'the old base-only lookup lost her');
    assert.equal(foundEditOk(n, 'her own room', NEW, env).ok, true);
    assert.match(foundEditOk(n, 'her own room', NEW, baseEnv).reason, /not on the map/);
});

test('make permanent refuses a room that only exists in this chat', () => {
    const base = client(RIVERTON).get('/cast').json().places;
    assert.equal(permanentProblem(NEW, base), CHAT_ONLY_ROOM);
    assert.match(CHAT_ONLY_ROOM, /only exists in this chat; save the room to the world first/);
    assert.equal(permanentProblem(UP, base), '');
});
}

// ---- from lore.test.mjs
{
// Lore: file keys, the lore chain, requests, the fed block, the index line and {{npc:id}} tokens.








const region = () => ({ name: 'Riverton', lore: 'A river town.', start: 'inn/common', subregions: {
    inn: { name: 'The Drowned Rat', lore: 'Run by {{npc:hesk}}.', locations: {
        common: { name: 'Common Room', description: 'Smoky.', lore: 'The hearth never goes out.', exits: [{ direction: 'up', to: 'loft' }] },
        loft: { name: 'Loft', description: 'Dusty.', inherit_subregion_lore: false, exits: [{ direction: 'down', to: 'common' }] },
    } },
} });
const load = () => load_world(makeWorld(tmpPath(), { r: region() }));

test('lore loads; the chain is innermost first and follows inherit rules', () => {
    const w = load();
    assert.deepEqual(w.lore_chain(w.get('r:inn/common')).map(c => [c.level, c.name]), [['room', 'Common Room'], ['subregion', 'The Drowned Rat'], ['region', 'Riverton']]);
    assert.deepEqual(w.lore_chain(w.get('r:inn/loft')).map(c => c.level), ['region'], 'inherit_subregion_lore: false drops the area lore');
    const d = w.to_dict(w.get('r:inn/common'));
    assert.equal(d.lore, 'The hearth never goes out.');
    assert.equal(d.lore_chain.length, 3);
});
test('the shipped worlds use lore, not notes', () => {
    const dir = new URL('../../worlds/riverton/regions/', import.meta.url);
    for (const f of fs.readdirSync(dir)) assert.ok(!/"(inherit_(region_|subregion_)?)?notes"\s*:/.test(fs.readFileSync(new URL(f, dir), 'utf8')), f);
});
const chain = [{ level: 'subregion', name: 'The Drowned Rat', text: 'Run by {{npc:hesk}}.' }, { level: 'region', name: 'Riverton', text: 'A river town.' }];
test('lore lookup', () => {
    assert.deepEqual(loreFor(chain, 'drowned rat').map(c => c.level), ['subregion']);
    assert.deepEqual(loreFor(chain, '').map(c => c.level), ['subregion', 'region']);
    assert.deepEqual(loreFor(chain, 'Larkspur'), []);
});
test('takeLoreFlags strips the tags and returns the places', () => {
    const r = takeLoreFlags('She pours.\n[ws_flag: lore | The Drowned Rat] [ws_flag: lore]');
    assert.deepEqual(r.places, ['The Drowned Rat', '']);
    assert.equal(r.text.trim(), 'She pours.');
});
test('requests stick for the scene at that place and stop when the place changes', () => {
    const at = ['a', 'a', 'a', 'b', 'b'];
    const chat = at.map((_, i) => ({ is_user: i % 2 === 0, mes: 'x', extra: {} }));
    addLoreRequest(chat[1], { place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' });
    assert.deepEqual(chat[1].extra.worldscrawl_lore, [{ swipe: 0, place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' }]);
    const playerAt = i => at[Math.min(i, at.length - 1)];
    assert.deepEqual(activeLore(chat, 2, chain, playerAt).map(c => c.level), ['subregion']);
    assert.deepEqual(activeLore(chat, 4, chain, playerAt), [], 'moved on: not fed');
    assert.deepEqual(activeLore(chat, 4, chain, playerAt, [{ place: '', source: 'bracket' }]).map(c => c.level), ['subregion', 'region']);
    assert.deepEqual(loreRequests(chat), [{ index: 1, place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' }]);
});
test('{{npc:id}} renders as the cast name; unknown ids show bare and warn', () => {
    const seen = [];
    assert.equal(renderNpcTokens('Run by {{npc:hesk}} and {{npc:nobody}}.', [{ id: 'hesk', name: 'Hesk' }], id => seen.push(id)), 'Run by Hesk and nobody.');
    assert.deepEqual(seen, ['nobody']);
});

const RAT = 'riverton:drowned_rat/common_room', STABLE = 'riverton:drowned_rat/stable', SQUARE = 'riverton:streets/square';
const ratChain = [{ level: 'subregion', name: 'The Drowned Rat', text: 'An inn.' }, { level: 'region', name: 'Riverton', text: 'A town.' }];
const walk = at => ({ chat: at.map((_, i) => ({ is_user: i % 2 === 0, mes: 'x', extra: {} })), playerAt: i => at[Math.min(i, at.length - 1)] });
test('loreScope covers room, subregion and region', () => {
    assert.equal(loreScope(RAT, 'room'), RAT);
    assert.equal(loreScope(RAT, 'subregion'), 'riverton:drowned_rat');
    assert.equal(loreScope(RAT, 'region'), 'riverton');
});
test('subregion lore asked in the common room stays fed in the stable, and drops once out of the building', () => {
    const { chat, playerAt } = walk([RAT, RAT, STABLE, STABLE, SQUARE, SQUARE, RAT]);
    addLoreRequest(chat[1], { place: 'The Drowned Rat', level: 'subregion', address: RAT, source: 'bracket' });
    assert.deepEqual(activeLore(chat, 3, ratChain, playerAt).map(c => c.level), ['subregion'], 'stable: still fed');
    assert.deepEqual(activeLore(chat, 5, ratChain, playerAt), [], 'square: dropped');
    assert.deepEqual(activeLore(chat, 6, ratChain, playerAt), [], 'back inside later: not revived');
});
test('region lore survives moving between buildings in the region', () => {
    const { chat, playerAt } = walk([RAT, RAT, SQUARE, STABLE, 'larkspur:farm/yard']);
    addLoreRequest(chat[1], { place: 'Riverton', level: 'region', address: RAT, source: 'flag' });
    assert.deepEqual(activeLore(chat, 2, ratChain, playerAt).map(c => c.level), ['region']);
    assert.deepEqual(activeLore(chat, 3, ratChain, playerAt).map(c => c.level), ['region']);
    assert.deepEqual(activeLore(chat, 4, ratChain, playerAt), [], 'another region: dropped');
});
test("level '' requests keep the exact-room rule", () => {
    const { chat, playerAt } = walk([RAT, RAT, STABLE]);
    addLoreRequest(chat[1], { place: 'Drowned Rat', level: '', address: RAT, source: 'bracket' });
    assert.deepEqual(activeLore(chat, 1, ratChain, playerAt).map(c => c.level), ['subregion']);
    assert.deepEqual(activeLore(chat, 2, ratChain, playerAt), []);
});
test('a claimed person field that is not on the card is a warning', () => {
    const npc = { id: 'hesk', name: 'Hesk', line: 'stern', facts: ['hates rats'], temps: [{ text: 'soaked' }], memory: ['owes a favor'], disposition: { player: { value: 'indifferent', reason: '' } }, effects: [], deep: { history: 'She runs the inn.' } };
    assert.equal(claimResult(npc, { type: 'npc_fact', field: 'fact', text: 'hates rats' }), 'landed');
    assert.equal(claimResult(npc, { type: 'npc_fact', field: 'fact', text: 'soaked' }), 'landed');
    assert.equal(claimResult(npc, { type: 'npc_fact', field: 'personality.summary', text: 'kinder' }), 'missed');
    assert.equal(claimResult(npc, { type: 'npc_fact', field: 'fact', text: 'a new scar', pending: true }), 'waiting');
    assert.equal(claimResult(npc, { type: 'npc_appearance', intent: 'magically young' }), 'missed');
    assert.equal(claimResult({ ...npc, liveOps: [{ owner: 'o1', lasts: 60 }] }, { type: 'npc_appearance', owner: 'o1', lasts: 60, committed: { intent: 'magically young' } }), 'landed');
    assert.equal(claimResult(npc, { type: 'npc_disposition', who: 'player', value: 'helpful' }), 'missed');
    assert.equal(claimResult(npc, { type: 'npc_memory', note: 'owes a favor' }), 'landed');
    const warns = claimWarnings(npc, [{ type: 'npc_fact', field: 'personality.summary', text: 'kinder' }, { type: 'npc_fact', field: 'fact', text: 'hates rats' }]);
    assert.deepEqual(warns, ['Warning: a person update for Hesk did not land on the card.']);
});
}
