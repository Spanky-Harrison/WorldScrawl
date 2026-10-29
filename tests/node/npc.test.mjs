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
import { NPC_KEY, SUGGEST_AFTER, clampDisposition, declinesInScene, exportRecord, focusRules, followersAt, framesOf, hashRoll, hourDistance, npcSlices, parseNpcTag, presentAt, readBack, readRememberAnswer, resolveSchedulePlace, scheduleAt, sightChance, sightCheck, suggestNames, takeNpcTags, validateRecord } from '../../plugin/npc.mjs';
import { loadCast, writeCastNpc } from '../../plugin/cast.mjs';
import { client, copytree, RIVERTON, TAVERN, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const UP = 'riverton:drowned_rat/upstairs';
const FORGE = 'riverton:smithy/forge';
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

test('following uses the player\'s place and overrides the schedule until told to stay', () => {
    const cast = [hesk()];
    const chat = [
        msg('Come with me.', npc([{ type: 'npc_follow', id: 'hesk', who: 'player' }])),
        msg('Wait here.', npc([{ type: 'npc_stay', id: 'hesk' }])),
    ];
    const along = presentAt(chat, 0, cast, envOf(FORGE, clock(9)));
    assert.equal(along[0].kind, 'follow');
    assert.equal(along[0].place, FORGE);
    assert.deepEqual(followersAt(chat, 0, cast).map(f => f.id), ['hesk']);
    const back = presentAt(chat, 1, cast, envOf(i => (i === 0 ? FORGE : UP), clock(9)));
    assert.equal(back.find(p => p.id === 'hesk').kind, 'schedule');
    assert.equal(followersAt(chat, 1, cast).length, 0);
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
    assert.match(slice.npc_focus, /Brisk/);
    assert.match(slice.npc_focus, /kettle crew/);
    assert.equal(focusRules('I sip my ale.', present).id, null);
    assert.equal(focusRules('I talk to her.', present).id, 'hesk');
    const messages = [
        { text: 'The barmaid sets down a mug.' },
        { text: 'The door creaks. The barmaid laughs.' },
        { text: 'I thank the barmaid.' },
        { text: 'Hello there.' }, { text: 'Hello again.' }, { text: 'Hello once more.' },
        { text: 'Maren nods.' }, { text: 'Then Maren grins.' }, { text: 'I pay Maren.' },
    ];
    const sug = suggestNames(messages, { known: ['Hesk'], places: ['Common Room'], threshold: SUGGEST_AFTER });
    assert.ok(sug.some(s => s.key === 'the barmaid'));
    assert.ok(!sug.some(s => s.key === 'the door'));
    assert.ok(sug.some(s => s.key === 'maren'));
    assert.ok(!sug.some(s => s.key === 'hello'));
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
    assert.deepEqual(readRememberAnswer({ name: 'Maren', line: 'A knife-grinder.', manner: '', voice: 'Squeak.' }), { name: 'Maren', line: 'A knife-grinder.', manner: '', voice: 'Squeak.', facts: [] });
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
    assert.equal(first.status_code, 200);
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
    const direct = writeCastNpc(dir, { id: 'old-tom', name: 'Old Tom', line: 'A stooped farmer.' });
    assert.equal(direct.id, 'old-tom');
});
