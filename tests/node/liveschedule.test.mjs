// The Cast summary's schedule is live: card entries with this chat's changes folded in, the entry in force marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveSchedule } from '../../plugin/ui/castdata.mjs';

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
