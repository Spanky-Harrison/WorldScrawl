import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comingsAndGoings, narratorView } from '../../extension/npc.mjs';
import { validateRecord } from '../../plugin/npc.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const UP = 'riverton:drowned_rat/upstairs';
const places = new Set([BAR, UP]);
const hesk = validateRecord({ id: 'hesk', name: 'Hesk', line: 'The landlady.', schedule: [
    { place: BAR, activity: 'pouring drinks', from: '16:00', to: '02:00', importance: 'high' }, { place: UP, activity: 'asleep' }] }, { file: 'hesk.json', places });
const at = (h, m = 0) => ({ day: 1, hour: Math.floor(h) % 24, minute: m, minutes: (h * 60 + m) % 1440, elapsed: 86400 + h * 3600 + m * 60 });
const envOf = (where, clocks) => ({ exists: a => places.has(a), relocate: {}, names: a => a, playerAt: i => (Array.isArray(where) ? where[i] : where), clock: i => clocks[i] });
const bot = { mes: 'The rain keeps on.', is_user: false, extra: {} };
const user = mes => ({ mes, is_user: true, extra: {} });

test('comings: someone due here arrives mid-wait, stamped with their schedule start', () => {
    const chat = [bot, user('I wait an hour.')];
    assert.deepEqual(comingsAndGoings(chat, 1, [hesk], envOf(BAR, [at(15, 30), at(16, 30)])), ['[16:00] Hesk arrives.']);
});

test('comings: the time is now when the schedule start is outside the wait', () => {
    const chat = [bot, user('I wait.')];
    const env = envOf(UP, [at(17), at(26)]); // upstairs: she comes up to sleep after 02:00
    assert.deepEqual(comingsAndGoings(chat, 1, [hesk], env), ['[02:00] Hesk arrives.']);
});

test('comings: anyone already in the scene stays; nobody comes or goes when the player moved or no time passed', () => {
    const chat = [bot, user('I keep drinking.')];
    assert.deepEqual(comingsAndGoings(chat, 1, [hesk], envOf(BAR, [at(18), at(27)])), [], 'mid-scene: no snap back to her schedule');
    assert.deepEqual(comingsAndGoings(chat, 1, [hesk], envOf([UP, BAR], [at(15, 30), at(16, 30)])), [], 'moved');
    assert.deepEqual(comingsAndGoings(chat, 1, [hesk], envOf(BAR, [at(15, 30), at(15, 30)])), [], 'no time');
    assert.deepEqual(comingsAndGoings([user('hi')], 0, [hesk], envOf(BAR, [at(16)])), [], 'no earlier reply');
});

test('comings: the inspector shows the lines that were sent', () => {
    const chat = [bot, user('I wait an hour.'), { mes: 'Hesk comes in.', is_user: false, extra: {} }];
    const v = narratorView(chat, 2, [hesk], envOf(BAR, [at(15, 30), at(16, 30), at(16, 31)]));
    assert.deepEqual(v.comings, ['[16:00] Hesk arrives.']);
});
